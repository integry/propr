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
    type TaskStateReconciliationResult,
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
    disconnect?(): void;
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

class RecoveryOperationTimeoutError extends Error {
    constructor(operation: string) {
        super(`${operation} exceeded the task state recovery time budget`);
        this.name = 'RecoveryOperationTimeoutError';
    }
}

class RecoveryClosedError extends Error {
    constructor() {
        super('Task state recovery is closing');
        this.name = 'RecoveryClosedError';
    }
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new RecoveryClosedError();
}

async function runWithinDeadline<T>(
    operationName: string,
    operation: () => Promise<T>,
    deadline: number,
    signal?: AbortSignal,
): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new RecoveryOperationTimeoutError(operationName);
    signal?.throwIfAborted();

    return new Promise<T>((resolve, reject) => {
        const finish = (callback: () => void): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = (): void => finish(() => reject(signal ? abortReason(signal) : new RecoveryClosedError()));
        const timer = setTimeout(
            () => finish(() => reject(new RecoveryOperationTimeoutError(operationName))),
            remainingMs,
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }

        let pending: Promise<T>;
        try {
            pending = operation();
        } catch (error) {
            finish(() => reject(error));
            return;
        }
        pending.then(
            value => finish(() => resolve(value)),
            error => finish(() => reject(error)),
        );
    });
}

async function runUntilAborted<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            cleanup();
            reject(abortReason(signal));
        };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }

        let pending: Promise<T>;
        try {
            pending = operation();
        } catch (error) {
            cleanup();
            reject(error);
            return;
        }
        pending.then(
            value => {
                cleanup();
                resolve(value);
            },
            error => {
                cleanup();
                reject(error);
            },
        );
    });
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
        maxRetriesPerRequest: 1,
        connectTimeout: 10_000,
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
    const leaseReleaseBudgetMs = Math.min(1_000, Math.max(1, Math.floor(timeBudgetMs / 10)));
    const dependencies = await runWithinDeadline(
        'Resolving task state recovery dependencies',
        () => resolveDependencies(options),
        Date.now() + timeBudgetMs,
    );
    const ownsRedis = options.redis === undefined;
    const redis = options.redis ?? createLeaseRedis();
    let cursor = '0';
    let backlog: TaskStateReconciliationResult['backlog'] = [];
    let closed = false;
    let activeRun: Promise<boolean> | null = null;
    let activeAbortController: AbortController | null = null;

    const execute = async (): Promise<boolean> => {
        if (closed) return false;
        const deadline = Date.now() + timeBudgetMs;
        const controller = new AbortController();
        activeAbortController = controller;
        const token = randomUUID();
        let acquired: unknown;
        try {
            acquired = await runWithinDeadline(
                'Task state recovery lease acquisition',
                () => redis.set(
                    RECONCILIATION_LEASE_KEY,
                    token,
                    'PX',
                    leaseTtlMs,
                    'NX',
                ),
                deadline,
                controller.signal,
            );
        } catch (error) {
            if (!closed) {
                logger.error({ error: (error as Error).message }, 'Failed to acquire task reconciliation lease');
            }
            return false;
        }
        if (acquired !== 'OK') return false;
        try {
            const reconciliationBudgetMs = deadline - Date.now() - leaseReleaseBudgetMs;
            if (reconciliationBudgetMs <= 0) {
                throw new RecoveryOperationTimeoutError('Task state reconciliation');
            }
            const result = await runUntilAborted(
                () => reconcileStalePRCommentTasks({
                    ...dependencies,
                    cursor,
                    backlog,
                    staleMs,
                    batchSize,
                    timeBudgetMs: reconciliationBudgetMs,
                    signal: controller.signal,
                }),
                controller.signal,
            );
            cursor = result.nextCursor;
            backlog = result.backlog ?? [];
            logger.info(result.summary, 'Reconciled stale PR comment task states');
            return true;
        } catch (error) {
            if (!closed) {
                logger.error({ error: (error as Error).message }, 'Failed to reconcile stale PR comment task states');
            }
            return false;
        } finally {
            try {
                await runWithinDeadline(
                    'Task state recovery lease release',
                    () => redis.eval(RELEASE_LEASE_SCRIPT, 1, RECONCILIATION_LEASE_KEY, token),
                    Date.now() + leaseReleaseBudgetMs,
                );
            } catch (error) {
                if (!closed) {
                    logger.warn({ error: (error as Error).message }, 'Failed to release task reconciliation lease');
                }
            }
        }
    };

    const runOnce = (): Promise<boolean> => {
        if (activeRun) return activeRun;
        activeRun = execute().finally(() => {
            activeRun = null;
            activeAbortController = null;
        });
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
            activeAbortController?.abort(new RecoveryClosedError());
            await activeRun;
            if (ownsRedis && redis.quit) {
                try {
                    await runWithinDeadline(
                        'Task state recovery Redis shutdown',
                        () => redis.quit!(),
                        Date.now() + Math.min(timeBudgetMs, 1_000),
                    );
                } catch (error) {
                    logger.warn({ error: (error as Error).message }, 'Failed to close task reconciliation Redis client cleanly');
                    redis.disconnect?.();
                }
            }
        },
    };
}
