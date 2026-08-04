import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
    findRunningDockerContainerForTask,
    getIssueQueue,
    getRedisConnectionOptions,
    getStateManager,
    logger,
    type JobResult,
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
    if (job.name !== 'processPullRequestComment' || !job.id) return false;
    if (await job.getState() !== 'failed') return false;
    return finalizePRCommentTaskFailure(String(job.id), stateManager, error);
}

/** Runs one reconciliation only while this process owns the distributed lease. */
export async function runWithTaskReconciliationLease(
    redis: ReconciliationLeaseRedis,
    leaseTtlMs: number,
    operation: () => Promise<void>,
): Promise<boolean> {
    const token = randomUUID();
    const acquired = await redis.set(RECONCILIATION_LEASE_KEY, token, 'PX', leaseTtlMs, 'NX');
    if (acquired !== 'OK') return false;

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
            }
        }).catch(error => {
            logger.warn({ error: (error as Error).message }, 'Failed to renew task reconciliation lease');
        }).finally(() => {
            renewal = null;
        });
    };
    const renewalInterval = setInterval(renew, Math.max(1000, Math.floor(leaseTtlMs / 3)));
    renewalInterval.unref();

    try {
        await operation();
        return true;
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
}

/** Adds terminal-state safety hooks and periodically repairs abandoned tasks. */
export async function startWorkerTaskStateRecovery(worker: MainWorker): Promise<WorkerTaskStateRecovery> {
    const stateManager = getStateManager();
    const pendingEventHandlers = new Set<Promise<void>>();
    const track = (operation: Promise<void>): void => {
        pendingEventHandlers.add(operation);
        void operation.finally(() => { pendingEventHandlers.delete(operation); });
    };

    const onCompleted = (job: { id?: string | number; name: string }, result: JobResult): void => {
        if (job.name !== 'processPullRequestComment' || !job.id) return;
        track((async () => {
            try {
                if ((result.status === 'rescheduled' || result.status === 'requeued')
                    && await findRunningDockerContainerForTask(String(job.id))) {
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

    const redis = new Redis(getRedisConnectionOptions({ lazyConnect: false }));
    redis.on('error', error => {
        logger.error({ error: error.message }, 'Redis error in task state recovery');
    });

    let queue;
    try {
        queue = await getIssueQueue();
    } catch (error) {
        worker.off('completed', onCompleted);
        worker.off('failed', onFailed);
        await redis.quit();
        throw error;
    }

    const intervalMs = positiveIntegerEnv('TASK_RECONCILIATION_INTERVAL_MS', 60 * 1000);
    const staleAfterMs = positiveIntegerEnv('TASK_RECONCILIATION_STALE_MS', DEFAULT_TASK_RECONCILIATION_STALE_MS);
    const leaseTtlMs = Math.max(intervalMs * 2, 2 * 60 * 1000);
    let inFlight: Promise<void> | null = null;
    let closing = false;
    const run = (): Promise<void> => {
        if (closing) return Promise.resolve();
        if (inFlight) return inFlight;
        inFlight = runWithTaskReconciliationLease(redis, leaseTtlMs, async () => {
            const summary = await reconcileStaleTaskStates({
                stateManager,
                queue,
                redis,
                staleAfterMs,
            });
            logger.info(summary, 'Task state reconciliation completed');
        }).then(ran => {
            if (!ran) logger.debug('Skipped task state reconciliation because another worker owns the lease');
        }).catch(error => {
            logger.error({ error: (error as Error).message }, 'Task state reconciliation failed');
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
            worker.off('completed', onCompleted);
            worker.off('failed', onFailed);
            await Promise.allSettled([...pendingEventHandlers]);
            await inFlight;
            await redis.quit();
        },
    };
}
