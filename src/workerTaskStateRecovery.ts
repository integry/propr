import { Redis } from 'ioredis';
import { findRunningDockerContainerForTask, getIssueQueue, getStateManager, logger } from '@propr/core';
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

function positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Adds terminal-state safety hooks and periodically repairs abandoned tasks. */
export async function startWorkerTaskStateRecovery(worker: MainWorker): Promise<WorkerTaskStateRecovery> {
    const stateManager = getStateManager();
    worker.on('completed', async (job, result) => {
        if (job.name !== 'processPullRequestComment' || !job.id) return;
        try {
            if ((result.status === 'rescheduled' || result.status === 'requeued')
                && await findRunningDockerContainerForTask(String(job.id))) {
                return;
            }
            await finalizePRCommentTaskResult(String(job.id), stateManager, result);
        } catch (error) {
            logger.error({ jobId: job.id, error: (error as Error).message }, 'Failed to finalize completed PR comment task state');
        }
    });
    worker.on('failed', async (job, error) => {
        if (job?.name !== 'processPullRequestComment' || !job.id) return;
        try {
            await finalizePRCommentTaskFailure(String(job.id), stateManager, error);
        } catch (finalizationError) {
            logger.error({ jobId: job.id, error: (finalizationError as Error).message }, 'Failed to finalize failed PR comment task state');
        }
    });

    const redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });
    const queue = await getIssueQueue();
    const intervalMs = positiveIntegerEnv('TASK_RECONCILIATION_INTERVAL_MS', 60 * 1000);
    const staleAfterMs = positiveIntegerEnv('TASK_RECONCILIATION_STALE_MS', DEFAULT_TASK_RECONCILIATION_STALE_MS);
    let inFlight: Promise<void> | null = null;
    const run = (): Promise<void> => {
        if (inFlight) return inFlight;
        inFlight = reconcileStaleTaskStates({ stateManager, queue, redis, staleAfterMs })
            .then(summary => { logger.info(summary, 'Task state reconciliation completed'); })
            .catch(error => { logger.error({ error: (error as Error).message }, 'Task state reconciliation failed'); })
            .finally(() => { inFlight = null; });
        return inFlight;
    };

    await run();
    const interval = setInterval(() => { void run(); }, intervalMs);
    interval.unref();

    return {
        close: async () => {
            clearInterval(interval);
            await inFlight;
            await redis.quit();
        },
    };
}
