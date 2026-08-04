import type { Logger } from 'pino';
import {
    logger,
    clearIndexingRuntimeStateBestEffort,
    getActiveRepositoryIndexingRuns,
    publishIndexingStatus,
    updateRepositoryStatus,
    type IndexingJobData,
} from '@propr/core';

interface FailedIndexingJob {
    data: IndexingJobData;
    attemptsMade: number;
    opts: { attempts?: number };
    failedReason?: string;
    finishedOn?: number;
    remove?: () => Promise<void>;
}

interface FailedIndexingQueue {
    getJobs(types: ['failed']): Promise<FailedIndexingJob[]>;
}

interface IndexingFailureDeps {
    log: Pick<Logger, 'error' | 'warn'>;
    publishIndexingStatus: typeof publishIndexingStatus;
    updateRepositoryStatus: typeof updateRepositoryStatus;
    getActiveRepositoryIndexingRuns: typeof getActiveRepositoryIndexingRuns;
    clearIndexingRuntimeStateBestEffort: typeof clearIndexingRuntimeStateBestEffort;
}

export async function handleIndexingJobFailure(
    job: FailedIndexingJob | undefined,
    error: Error,
    overrides: Partial<IndexingFailureDeps> = {}
): Promise<boolean> {
    if (!job?.data.repository) return false;
    const deps: IndexingFailureDeps = {
        log: logger,
        publishIndexingStatus,
        updateRepositoryStatus,
        getActiveRepositoryIndexingRuns,
        clearIndexingRuntimeStateBestEffort,
        ...overrides,
    };
    const branch = job.data.baseBranch || 'HEAD';
    const attempts = Math.max(1, job.opts.attempts ?? 1);
    if (job.attemptsMade < attempts) {
        deps.log.warn({
            repository: job.data.repository,
            branch,
            attempt: job.attemptsMade,
            attempts,
            error: error.message,
        }, 'Indexing job attempt failed and will be retried');
        return false;
    }

    let runId = job.data.runId;
    if (!runId) {
        const [ownedRun] = await deps.getActiveRepositoryIndexingRuns(
            job.data.repository,
            branch
        );
        const ownedTransitionTime = ownedRun ? Date.parse(ownedRun.transitionAt) : Number.NaN;
        const ownedAtFailure = ownedRun && Number.isFinite(ownedTransitionTime)
            && (job.finishedOn === undefined || ownedTransitionTime <= job.finishedOn);
        runId = ownedAtFailure ? ownedRun.runId : undefined;
        if (ownedAtFailure) {
            Object.assign(job.data, {
                runId: ownedRun.runId,
                transitionAt: ownedRun.transitionAt,
                durablyAccepted: true,
            });
        }
    }
    if (!runId) {
        deps.log.error({ repository: job.data.repository, branch, error: error.message },
            'Could not resolve durable indexing run for failed job; retaining it for reconciliation');
        return false;
    }

    deps.log.error({ repository: job.data.repository, branch, error: error.message },
        'Indexing job exhausted retries, marking repository as failed');
    let transition: Awaited<ReturnType<typeof updateRepositoryStatus>>;
    try {
        transition = await deps.updateRepositoryStatus(
            job.data.repository,
            'failed',
            branch,
            { runId }
        );
    } catch (updateError) {
        deps.log.error({
            repository: job.data.repository,
            branch,
            error: (updateError as Error).message,
        }, 'Failed to update repository status after job failure; retaining failed job for reconciliation');
        return false;
    }
    if (transition.applied) {
        try {
            await deps.publishIndexingStatus(job.data.repository, branch, 'failed', transition);
        } catch (publicationError) {
            deps.log.warn({
                repository: job.data.repository,
                branch,
                error: (publicationError as Error).message,
            }, 'Failed to publish durable indexing failure; reconciliation will retry projection');
        }
    }
    await deps.clearIndexingRuntimeStateBestEffort(job.data.repository, branch, runId);
    return true;
}

/** Replays terminal writes from BullMQ's retained failed-job set. */
export async function reconcileFailedIndexingJobs(
    queue: FailedIndexingQueue,
    overrides: Partial<IndexingFailureDeps> = {}
): Promise<number> {
    const jobs = await queue.getJobs(['failed']);
    let reconciled = 0;
    for (const job of jobs) {
        const attempts = Math.max(1, job.opts.attempts ?? 1);
        if (job.attemptsMade < attempts) continue;
        const finalized = await handleIndexingJobFailure(
            job,
            new Error(job.failedReason || 'Retained indexing job failed'),
            overrides
        );
        if (!finalized) continue;
        try {
            await job.remove?.();
        } catch (error) {
            (overrides.log ?? logger).warn({
                repository: job.data.repository,
                error: error instanceof Error ? error.message : String(error),
            }, 'Failed to remove reconciled indexing job');
        }
        reconciled++;
    }
    return reconciled;
}
