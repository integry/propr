import type { Job } from 'bullmq';
import {
    clearIndexingRuntimeStateBestEffort,
    createIndexingRunIdentity,
    indexRepo,
    logger,
    updateRepositoryStatus,
    type IndexingJobData,
    type JobResult,
} from '@propr/core';

export interface IndexingResult extends JobResult {
    success: boolean;
    filesProcessed?: number;
    duration?: number;
}

interface IndexingJobProcessorDeps {
    indexRepo: typeof indexRepo;
    updateRepositoryStatus: typeof updateRepositoryStatus;
    createIndexingRunIdentity: typeof createIndexingRunIdentity;
    clearIndexingRuntimeStateBestEffort: typeof clearIndexingRuntimeStateBestEffort;
}

const defaultDeps: IndexingJobProcessorDeps = {
    indexRepo,
    updateRepositoryStatus,
    createIndexingRunIdentity,
    clearIndexingRuntimeStateBestEffort,
};

async function processWithDeps(
    job: Job<IndexingJobData>,
    deps: IndexingJobProcessorDeps
): Promise<IndexingResult> {
    const {
        repository, repoPath, correlationId, fullReindex, baseBranch = 'HEAD', ignoreCooldown
    } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const startTime = Date.now();
    correlatedLogger.info({ repository, repoPath, fullReindex, branch: baseBranch },
        'Starting indexing job...');

    try {
        let indexingRun = job.data.runId && job.data.transitionAt
            ? { runId: job.data.runId, transitionAt: job.data.transitionAt }
            : undefined;
        if (!indexingRun) {
            const requestedRun = deps.createIndexingRunIdentity();
            const transition = await deps.updateRepositoryStatus(repository, 'indexing', baseBranch, {
                ...requestedRun,
                startNewRun: true
            });
            if (!transition.applied) {
                await deps.clearIndexingRuntimeStateBestEffort(
                    repository, baseBranch, requestedRun.runId
                );
                return { status: 'skipped', success: true };
            }
            indexingRun = { runId: transition.runId, transitionAt: transition.transitionAt };
            await job.updateData({ ...job.data, ...indexingRun, durablyAccepted: true });
        } else {
            let transition = await deps.updateRepositoryStatus(
                repository, 'indexing', baseBranch, indexingRun
            );
            // Legacy jobs acquired ownership on worker startup. Newly accepted
            // jobs must never reopen a run cancelled after enqueue.
            if (!transition.applied && job.data.durablyAccepted !== true) {
                transition = await deps.updateRepositoryStatus(repository, 'indexing', baseBranch, {
                    ...indexingRun,
                    startNewRun: true
                });
            }
            if (!transition.applied) {
                await deps.clearIndexingRuntimeStateBestEffort(
                    repository, baseBranch, indexingRun.runId
                );
                return { status: 'skipped', success: true };
            }
            indexingRun = { runId: transition.runId, transitionAt: transition.transitionAt };
            if (job.data.durablyAccepted !== true
                || job.data.transitionAt !== transition.transitionAt) {
                await job.updateData({ ...job.data, ...indexingRun, durablyAccepted: true });
            }
        }

        const outcome = await deps.indexRepo(repoPath, {
            correlationId,
            fullName: repository,
            branch: baseBranch,
            fullReindex,
            ignoreCooldown,
            deferFailureFinalization: true,
            ...indexingRun
        });
        const duration = Date.now() - startTime;
        if (outcome !== 'indexed') {
            correlatedLogger.info({ repository, duration, outcome }, 'Indexing job skipped');
            return { status: 'skipped', success: true, duration, reason: outcome };
        }
        correlatedLogger.info({ repository, duration }, 'Indexing job completed successfully');
        return { status: 'completed', success: true, duration };
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error(
            { repository, error: err.message, stack: err.stack },
            'Indexing job failed'
        );
        throw error;
    }
}

export function createIndexingJobProcessor(
    overrides: Partial<IndexingJobProcessorDeps> = {}
): (job: Job<IndexingJobData>) => Promise<IndexingResult> {
    const deps = { ...defaultDeps, ...overrides };
    return (job) => processWithDeps(job, deps);
}

export const processIndexingJob = createIndexingJobProcessor();
