import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
    findRunningDockerContainerForTask,
    getIssueQueue,
    getRedisConnectionOptions,
    getStateManager,
    logger,
    type WorkerStateManager,
} from '@propr/core';
import type { MainWorker } from './workerFactory.js';
import {
    finalizePRCommentTaskFailure,
    finalizePRCommentTaskResult,
} from './jobs/prCommentTaskFinalizer.js';
import {
    DEFAULT_TASK_RECONCILIATION_STALE_MS,
    reconcileStaleTaskStates,
} from './taskStateReconciler.js';

export interface WorkerTaskStateRecovery {
    close(): Promise<void>;
}

export interface WorkerTaskStateFinalizers {
    close(): Promise<void>;
}

interface FailedEventJob {
    id?: string | number;
    name: string;
    getState(): Promise<string>;
}

interface ReconciliationLeaseRedis {
    set(key: string, value: string, mode: 'PX', duration: number, condition: 'NX'): Promise<unknown>;
    eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const RECONCILIATION_LEASE_KEY = 'lock:worker:task-state-reconciliation';
const RELEASE_RECONCILIATION_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
`;
const RENEW_RECONCILIATION_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

function positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** BullMQ emits `failed` for retryable attempts too; only its failed set is terminal. */
export async function finalizeTerminalPRCommentJobFailure(
    job: FailedEventJob,
    error: Error,
    stateManager: Pick<WorkerStateManager, 'getTaskState' | 'updateTaskStateIfCurrent'>,
): Promise<boolean> {
    if (job.name !== 'processPullRequestComment' || job.id == null) return false;
    if (await job.getState() !== 'failed') return false;
    return finalizePRCommentTaskFailure(String(job.id), stateManager, error);
}

/** Runs one reconciliation only while this process owns the distributed lease. */
export async function runWithTaskReconciliationLease(
    redis: ReconciliationLeaseRedis,
    leaseTtlMs: number,
    operation: (signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
    const token = randomUUID();
    const acquired = await redis.set(RECONCILIATION_LEASE_KEY, token, 'PX', leaseTtlMs, 'NX');
    if (acquired !== 'OK') return false;

    const leaseController = new AbortController();
    let renewal: Promise<void> | null = null;
    const renew = (): void => {
        if (renewal) return;
        renewal = redis.eval(
            RENEW_RECONCILIATION_LEASE_SCRIPT,
            1,
            RECONCILIATION_LEASE_KEY,
            token,
            leaseTtlMs,
        ).then(result => {
            if (Number(result) !== 1) {
                logger.warn('Lost the distributed task reconciliation lease');
                leaseController.abort(new Error('Lost the distributed task reconciliation lease'));
            }
        }).catch(error => {
            logger.warn({ error: (error as Error).message }, 'Failed to renew task reconciliation lease');
            leaseController.abort(new Error('Failed to renew the distributed task reconciliation lease', {
                cause: error,
            }));
        }).finally(() => {
            renewal = null;
        });
    };
    const renewalInterval = setInterval(renew, Math.max(10, Math.floor(leaseTtlMs / 3)));
    renewalInterval.unref();

    let completed = false;
    try {
        await operation(leaseController.signal);
        completed = true;
    } catch (error) {
        if (!leaseController.signal.aborted) throw error;
    } finally {
        clearInterval(renewalInterval);
        await renewal;
        await redis.eval(
            RELEASE_RECONCILIATION_LEASE_SCRIPT,
            1,
            RECONCILIATION_LEASE_KEY,
            token,
        );
    }
    return completed && !leaseController.signal.aborted;
}

/** Attaches terminal-state safety hooks until the worker has drained. */
export function attachPRCommentTaskStateFinalizers(
    worker: MainWorker,
    stateManager: Pick<WorkerStateManager, 'getTaskState' | 'updateTaskStateIfCurrent'>,
    findRunningContainer: typeof findRunningDockerContainerForTask = findRunningDockerContainerForTask,
): WorkerTaskStateFinalizers {
    const pendingEventHandlers = new Set<Promise<void>>();
    const track = (operation: Promise<void>): void => {
        pendingEventHandlers.add(operation);
        void operation.finally(() => { pendingEventHandlers.delete(operation); });
    };

    const onCompleted = (job: { id?: string | number; name: string }, result: unknown): void => {
        if (job.name !== 'processPullRequestComment' || job.id == null) return;
        track((async () => {
            try {
                const status = result && typeof result === 'object'
                    ? (result as { status?: unknown }).status
                    : undefined;
                if ((status === 'rescheduled' || status === 'requeued')
                    && await findRunningContainer(String(job.id))) {
                    return;
                }
                await finalizePRCommentTaskResult(String(job.id), stateManager, result);
            } catch (error) {
                logger.error({ jobId: job.id, error: (error as Error).message }, 'Failed to finalize completed PR comment task state');
            }
        })());
    };
    const onFailed = (job: FailedEventJob | undefined, error: Error): void => {
        if (!job) return;
        track((async () => {
            try {
                await finalizeTerminalPRCommentJobFailure(job, error, stateManager);
            } catch (finalizationError) {
                logger.error({ jobId: job.id, error: (finalizationError as Error).message }, 'Failed to finalize failed PR comment task state');
            }
        })());
    };

    worker.on('completed', onCompleted);
    worker.on('failed', onFailed);

    return {
        close: async () => {
            worker.off('completed', onCompleted);
            worker.off('failed', onFailed);
            await Promise.allSettled([...pendingEventHandlers]);
        },
    };
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation.then(() => true),
            new Promise<false>(resolve => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

/** Adds terminal-state safety hooks and periodically repairs abandoned tasks. */
export async function startWorkerTaskStateRecovery(worker: MainWorker): Promise<WorkerTaskStateRecovery> {
    const stateManager = getStateManager();
    const finalizers = attachPRCommentTaskStateFinalizers(worker, stateManager);
    const shutdownTimeoutMs = positiveIntegerEnv('TASK_RECONCILIATION_SHUTDOWN_TIMEOUT_MS', 10_000);

    const redis = new Redis(getRedisConnectionOptions({
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        commandTimeout: shutdownTimeoutMs,
    }));
    redis.on('error', error => {
        logger.error({ error: error.message }, 'Redis error in task state recovery');
    });

    let queue;
    try {
        queue = await getIssueQueue();
    } catch (error) {
        await finalizers.close();
        redis.disconnect();
        throw error;
    }

    const intervalMs = positiveIntegerEnv('TASK_RECONCILIATION_INTERVAL_MS', 60 * 1000);
    const staleAfterMs = positiveIntegerEnv('TASK_RECONCILIATION_STALE_MS', DEFAULT_TASK_RECONCILIATION_STALE_MS);
    const leaseTtlMs = Math.max(intervalMs * 2, 2 * 60 * 1000);
    let inFlight: Promise<void> | null = null;
    let closing = false;
    const shutdownController = new AbortController();
    const run = (): Promise<void> => {
        if (closing) return Promise.resolve();
        if (inFlight) return inFlight;
        inFlight = runWithTaskReconciliationLease(redis, leaseTtlMs, async leaseSignal => {
            const signal = AbortSignal.any([leaseSignal, shutdownController.signal]);
            const summary = await reconcileStaleTaskStates({
                stateManager,
                queue,
                redis,
                staleAfterMs,
                signal,
            });
            logger.info(summary, 'Task state reconciliation completed');
        }).then(ran => {
            if (!ran) logger.debug('Stopped task state reconciliation because its distributed lease was not held');
        }).catch(error => {
            if (closing && shutdownController.signal.aborted) {
                logger.debug('Task state reconciliation stopped during worker shutdown');
            } else {
                logger.error({ error: (error as Error).message }, 'Task state reconciliation failed');
            }
        }).finally(() => {
            inFlight = null;
        });
        return inFlight;
    };

    // Recovery must not hold up worker startup.
    void run();
    const interval = setInterval(() => { void run(); }, intervalMs);
    interval.unref();

    return {
        close: async () => {
            closing = true;
            clearInterval(interval);
            shutdownController.abort(new Error('Worker task state recovery is shutting down'));
            const outstanding = [finalizers.close(), ...(inFlight ? [inFlight] : [])];
            const settled = await settlesWithin(Promise.allSettled(outstanding), shutdownTimeoutMs);
            if (!settled) {
                logger.warn({ shutdownTimeoutMs }, 'Timed out waiting for task state recovery to stop');
                redis.disconnect();
                return;
            }
            try {
                await redis.quit();
            } catch (error) {
                logger.warn({ error: (error as Error).message }, 'Failed to close task state recovery Redis cleanly');
                redis.disconnect();
            }
        },
    };
}
