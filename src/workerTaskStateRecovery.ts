import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
    getIssueQueue,
    getStateManager,
    logger,
    type WorkerStateManager,
} from '@propr/core';
import {
    DEFAULT_RECONCILIATION_STALE_MS,
    DEFAULT_RECONCILIATION_TIME_BUDGET_MS,
    reconcileStalePRCommentTasks,
    type ReconciliationQueue,
    type ReconciliationStateManager,
} from './taskStateReconciler.js';

const RECONCILIATION_LEASE_KEY = 'lock:worker:pr-task-state-reconciliation';
const RELEASE_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;

interface ReconciliationLeaseRedis {
    set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<unknown>;
    eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
    quit?(): Promise<unknown>;
}

export interface WorkerTaskStateRecovery {
    runOnce(): Promise<boolean>;
    close(): Promise<void>;
}

export interface WorkerTaskStateRecoveryOptions {
    queue?: ReconciliationQueue;
    stateManager?: ReconciliationStateManager;
    redis?: ReconciliationLeaseRedis;
    intervalMs?: number;
    leaseTtlMs?: number;
    staleMs?: number;
    batchSize?: number;
    timeBudgetMs?: number;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : fallback;
}

function createLeaseRedis(): InstanceType<typeof Redis> {
    return new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });
}

async function resolveDependencies(options: WorkerTaskStateRecoveryOptions): Promise<{
    queue: ReconciliationQueue;
    stateManager: ReconciliationStateManager;
}> {
    return {
        queue: options.queue ?? await getIssueQueue(),
        stateManager: options.stateManager ?? getStateManager() as WorkerStateManager,
    };
}

export async function startWorkerTaskStateRecovery(
    options: WorkerTaskStateRecoveryOptions = {},
): Promise<WorkerTaskStateRecovery> {
    const dependencies = await resolveDependencies(options);
    const intervalMs = options.intervalMs ?? boundedInteger(
        process.env.TASK_STATE_RECONCILIATION_INTERVAL_MS,
        60_000,
        10_000,
        60 * 60 * 1000,
    );
    const staleMs = options.staleMs ?? boundedInteger(
        process.env.TASK_STATE_RECONCILIATION_STALE_MS,
        DEFAULT_RECONCILIATION_STALE_MS,
        60_000,
        7 * 24 * 60 * 60 * 1000,
    );
    const batchSize = options.batchSize ?? boundedInteger(
        process.env.TASK_STATE_RECONCILIATION_BATCH_SIZE,
        100,
        1,
        1_000,
    );
    const timeBudgetMs = options.timeBudgetMs ?? boundedInteger(
        process.env.TASK_STATE_RECONCILIATION_TIME_BUDGET_MS,
        DEFAULT_RECONCILIATION_TIME_BUDGET_MS,
        1_000,
        120_000,
    );
    const leaseTtlMs = options.leaseTtlMs ?? Math.max(5 * 60_000, timeBudgetMs * 3);
    const ownsRedis = options.redis === undefined;
    const redis = options.redis ?? createLeaseRedis();
    let cursor = '0';
    let closed = false;
    let activeRun: Promise<boolean> | null = null;

    const execute = async (): Promise<boolean> => {
        if (closed) return false;
        const token = randomUUID();
        let acquired: unknown;
        try {
            acquired = await redis.set(
                RECONCILIATION_LEASE_KEY,
                token,
                'PX',
                leaseTtlMs,
                'NX',
            );
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Failed to acquire task reconciliation lease');
            return false;
        }
        if (acquired !== 'OK') return false;
        try {
            const result = await reconcileStalePRCommentTasks({
                ...dependencies,
                cursor,
                staleMs,
                batchSize,
                timeBudgetMs,
            });
            cursor = result.nextCursor;
            logger.info(result.summary, 'Reconciled stale PR comment task states');
            return true;
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Failed to reconcile stale PR comment task states');
            return false;
        } finally {
            try {
                await redis.eval(RELEASE_LEASE_SCRIPT, 1, RECONCILIATION_LEASE_KEY, token);
            } catch (error) {
                logger.warn({ error: (error as Error).message }, 'Failed to release task reconciliation lease');
            }
        }
    };

    const runOnce = (): Promise<boolean> => {
        activeRun ??= execute().finally(() => { activeRun = null; });
        return activeRun;
    };
    const timer = setInterval(() => { void runOnce(); }, intervalMs);
    timer.unref();
    void runOnce();

    return {
        runOnce,
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            await activeRun;
            if (ownsRedis) await redis.quit?.();
        },
    };
}
