import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import {
    abortSpawnedExecution,
    type SpawnedExecutionState,
} from './dockerExecutionOwnership.js';

export interface AbortCheckerOptions {
    taskId: string;
    plannerAbortKey: string;
    child: ChildProcess;
    state: SpawnedExecutionState;
    namedContainer: string | null;
    attemptGeneration?: string;
    redisFactory?: AbortRedisFactory;
    pollIntervalMs?: number;
}

export interface AbortCheckerHandle {
    close(): Promise<void>;
}

interface PlannerAbortContext {
    draftId: string;
    runId: string;
}

export interface AbortRedisClient {
    get(key: string): Promise<string | null>;
    del(key: string): Promise<unknown>;
    quit(): Promise<unknown>;
    disconnect(): void;
}

export type AbortRedisFactory = () => AbortRedisClient;

const plannerAbortContext = new AsyncLocalStorage<PlannerAbortContext>();
const PLANNER_ABORT_LOOKUP_FAILURE_LIMIT = 2;

export function buildPlannerAbortSignalKey(draftId: string, runId?: string): string {
    return runId ? `planner:abort:${draftId}:run:${runId}` : `planner:abort:${draftId}`;
}

export function runWithPlannerAbortContext<T>(
    draftId: string,
    runId: string,
    operation: () => Promise<T>
): Promise<T> {
    return plannerAbortContext.run({ draftId, runId }, operation);
}

export function plannerAbortSignalKeyForTask(taskId: string): string {
    const context = plannerAbortContext.getStore();
    return context
        ? buildPlannerAbortSignalKey(context.draftId, context.runId)
        : buildPlannerAbortSignalKey(taskId);
}

function createAbortRedis(): AbortRedisClient {
    return new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
    });
}

async function closeAbortRedis(redis: AbortRedisClient): Promise<void> {
    try {
        await redis.quit();
    } catch {
        try { redis.disconnect(); } catch { /* best-effort fallback */ }
    }
}

async function readAbortSignal(
    redis: AbortRedisClient,
    taskId: string,
    plannerAbortKey: string,
): Promise<boolean> {
    const [workerAbort, plannerAbort] = await Promise.all([
        redis.get(`worker:abort:${taskId}`),
        redis.get(plannerAbortKey)
    ]);
    return workerAbort !== null || plannerAbort !== null;
}

export async function checkAbortSignal(
    taskId: string,
    plannerAbortKey: string,
    factory: AbortRedisFactory = createAbortRedis
): Promise<boolean> {
    const redis = factory();
    try {
        return await readAbortSignal(redis, taskId, plannerAbortKey);
    } catch (error) {
        throw new Error(`Abort state unavailable for task ${taskId}`, { cause: error });
    } finally {
        await closeAbortRedis(redis);
    }
}

/** Consumes only the worker abort signal; planner markers remain until expiry. */
export async function clearWorkerAbortSignal(
    taskId: string,
    factory: AbortRedisFactory = createAbortRedis
): Promise<void> {
    const redis = factory();
    try {
        await redis.del(`worker:abort:${taskId}`);
        logger.debug({ taskId }, 'Cleared worker abort signal from Redis');
    } catch (err) {
        logger.warn({ taskId, error: (err as Error).message }, 'Failed to clear worker abort signal from Redis');
    } finally {
        await closeAbortRedis(redis);
    }
}

async function clearWorkerAbortSignalWithClient(taskId: string, redis: AbortRedisClient): Promise<void> {
    try {
        await redis.del(`worker:abort:${taskId}`);
        logger.debug({ taskId }, 'Cleared worker abort signal from Redis');
    } catch (err) {
        logger.warn({ taskId, error: (err as Error).message }, 'Failed to clear worker abort signal from Redis');
    }
}

export function scheduleForceKill(child: ChildProcess): void {
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    timer.unref();
}

/** Fails closed after sustained planner cancellation lookup failures. */
export function shouldTerminateAfterAbortLookupFailure(
    plannerAbortKey: string,
    consecutiveFailures: number,
): boolean {
    return plannerAbortKey.includes(':run:')
        && consecutiveFailures >= PLANNER_ABORT_LOOKUP_FAILURE_LIMIT;
}

export function setupAbortChecker({
    taskId,
    plannerAbortKey,
    child,
    state,
    namedContainer,
    attemptGeneration,
    redisFactory = createAbortRedis,
    pollIntervalMs = 2000,
}: AbortCheckerOptions): AbortCheckerHandle {
    const redis = redisFactory();
    let pollInFlight = false;
    let active = true;
    let consecutiveLookupFailures = 0;
    let closePromise: Promise<void> | null = null;
    let pollPromise: Promise<void> | null = null;
    const terminateExecution = async (message: string): Promise<void> => {
        if (state.aborted.value) return;
        logger.info({ taskId, containerId: state.containerId.value || namedContainer }, message);
        await abortSpawnedExecution(
            child,
            state,
            { namedContainer, scheduleForceKill, taskId, attemptGeneration },
        );
        await clearWorkerAbortSignalWithClient(taskId, redis);
    };
    const interval = setInterval(() => {
        if (pollInFlight) return;
        pollInFlight = true;
        pollPromise = (async () => {
            const shouldAbort = await readAbortSignal(redis, taskId, plannerAbortKey);
            if (!active) return;
            consecutiveLookupFailures = 0;
            if (shouldAbort) await terminateExecution('Abort signal detected, terminating execution');
        })().catch(async error => {
            if (!active) return;
            consecutiveLookupFailures += 1;
            logger.error({ taskId, plannerAbortKey, error: (error as Error).message }, 'Abort state unavailable; cancellation cannot be verified');
            if (shouldTerminateAfterAbortLookupFailure(plannerAbortKey, consecutiveLookupFailures)) {
                await terminateExecution('Planner abort state unavailable, terminating execution fail closed');
            }
        }).finally(() => {
            pollInFlight = false;
            pollPromise = null;
        });
    }, pollIntervalMs);
    return {
        close: async () => {
            closePromise ??= (async () => {
                active = false;
                clearInterval(interval);
                await pollPromise;
                await closeAbortRedis(redis);
            })();
            await closePromise;
        }
    };
}
