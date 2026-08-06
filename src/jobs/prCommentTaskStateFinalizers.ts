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
    type PRCommentTaskFinalizationResult,
} from './prCommentTaskFinalizer.js';

const FAILURE_STATE_ATTEMPTS = 3;

export interface PRCommentTaskStateFinalizers {
    close(): Promise<void>;
}

async function waitForFailureStateRetry(attempt: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
}

async function isFailureExhausted(job: Job<MainJobData>): Promise<boolean> {
    const configuredAttempts = Math.max(1, job.opts.attempts ?? 1);
    if (job.attemptsMade >= configuredAttempts) return true;

    for (let attempt = 0; attempt < FAILURE_STATE_ATTEMPTS; attempt++) {
        try {
            const state = await job.getState();
            if (state === 'failed') return true;
            if (state === 'unknown' && job.opts.removeOnFail) return true;
            return false;
        } catch (error) {
            if (attempt === FAILURE_STATE_ATTEMPTS - 1) throw error;
            await waitForFailureStateRetry(attempt);
        }
    }
    return false;
}

export function attachPRCommentTaskStateFinalizers(
    worker: MainWorker,
    stateManager: WorkerStateManager,
): PRCommentTaskStateFinalizers {
    const pending = new Set<Promise<void>>();
    let closed = false;

    const track = (operation: Promise<PRCommentTaskFinalizationResult>, taskId: string): void => {
        const tracked = operation
            .then(result => {
                if (result.outcome === 'finalized') {
                    logger.info({ taskId }, 'Finalized PR comment task from BullMQ job state');
                } else if (result.outcome === 'partial_publication') {
                    logger.error({ taskId, publication: result.publication },
                        'Finalized PR comment task in Redis with incomplete publication');
                } else if (result.outcome === 'task_missing') {
                    logger.warn({ taskId }, 'Could not finalize PR comment task because its state is missing');
                } else if (result.outcome === 'retry_pending') {
                    logger.debug({ taskId }, 'PR comment job failure is retryable; task was not finalized');
                } else {
                    logger.debug({ taskId }, 'PR comment task was already terminal during finalization');
                }
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
        const finalizeIfExhausted = async (): Promise<PRCommentTaskFinalizationResult> => {
            if (!await isFailureExhausted(job)) {
                return { outcome: 'retry_pending', stateChanged: false };
            }
            return finalizeFailedPRCommentTask(taskId, error, stateManager);
        };
        track(finalizeIfExhausted(), taskId);
    };

    worker.on('completed', onCompleted);
    worker.on('failed', onFailed);

    return {
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            worker.off('completed', onCompleted);
            worker.off('failed', onFailed);
            if (pending.size === 0) return;
            await Promise.allSettled([...pending]);
        },
    };
}
