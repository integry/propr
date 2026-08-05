import type { Job } from 'bullmq';
import {
    logger,
    type JobResult,
    type WorkerStateManager,
} from '@propr/core';
import type { MainJobData, MainWorker } from '../workerFactory.js';
import {
    finalizeCompletedPRCommentTask,
    finalizeFailedPRCommentTask,
} from './prCommentTaskFinalizer.js';

export interface PRCommentTaskStateFinalizers {
    close(): Promise<void>;
}

export function attachPRCommentTaskStateFinalizers(
    worker: MainWorker,
    stateManager: WorkerStateManager,
): PRCommentTaskStateFinalizers {
    const pending = new Set<Promise<void>>();

    const track = (operation: Promise<boolean>, taskId: string): void => {
        const tracked = operation
            .then(updated => {
                if (updated) logger.info({ taskId }, 'Finalized PR comment task from BullMQ job state');
            })
            .catch(error => {
                logger.error({ taskId, error: (error as Error).message }, 'Failed to finalize PR comment task state');
            })
            .finally(() => pending.delete(tracked));
        pending.add(tracked);
    };

    const onCompleted = (job: Job<MainJobData>, result: JobResult): void => {
        if (job.name !== 'processPullRequestComment' || !job.id) return;
        track(finalizeCompletedPRCommentTask(job.id, result, stateManager), job.id);
    };

    const onFailed = (job: Job<MainJobData> | undefined, error: Error): void => {
        if (job?.name !== 'processPullRequestComment' || !job.id) return;
        const taskId = job.id;
        const finalizeIfExhausted = async (): Promise<boolean> => {
            if (await job.getState() !== 'failed') return false;
            return finalizeFailedPRCommentTask(taskId, error, stateManager);
        };
        track(finalizeIfExhausted(), taskId);
    };

    worker.on('completed', onCompleted);
    worker.on('failed', onFailed);

    return {
        async close(): Promise<void> {
            worker.off('completed', onCompleted);
            worker.off('failed', onFailed);
            await Promise.allSettled([...pending]);
        },
    };
}
