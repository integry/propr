import type { Logger } from 'pino';
import {
    logger,
    clearIndexingRuntimeStateBestEffort,
    publishIndexingStatus,
    updateRepositoryStatus,
    type IndexingJobData,
} from '@propr/core';

interface FailedIndexingJob {
    data: IndexingJobData;
    attemptsMade: number;
    opts: { attempts?: number };
}

interface IndexingFailureDeps {
    log: Pick<Logger, 'error' | 'warn'>;
    publishIndexingStatus: typeof publishIndexingStatus;
    updateRepositoryStatus: typeof updateRepositoryStatus;
    clearIndexingRuntimeStateBestEffort: typeof clearIndexingRuntimeStateBestEffort;
}

export async function handleIndexingJobFailure(
    job: FailedIndexingJob | undefined,
    error: Error,
    overrides: Partial<IndexingFailureDeps> = {}
): Promise<void> {
    if (!job?.data.repository || !job.data.runId) return;
    const deps: IndexingFailureDeps = {
        log: logger,
        publishIndexingStatus,
        updateRepositoryStatus,
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
        return;
    }

    deps.log.error({ repository: job.data.repository, branch, error: error.message },
        'Indexing job exhausted retries, marking repository as failed');
    try {
        const transition = await deps.updateRepositoryStatus(
            job.data.repository,
            'failed',
            branch,
            { runId: job.data.runId }
        );
        if (transition.applied) {
            await deps.publishIndexingStatus(job.data.repository, branch, 'failed', transition);
        }
    } catch (updateError) {
        deps.log.error({
            repository: job.data.repository,
            branch,
            error: (updateError as Error).message,
        }, 'Failed to update repository status after job failure');
    } finally {
        await deps.clearIndexingRuntimeStateBestEffort(
            job.data.repository,
            branch,
            job.data.runId
        );
    }
}
