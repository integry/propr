import type { Job } from 'bullmq';
import {
    clearIndexingRuntimeStateBestEffort,
    createLegacyIndexingRunIdForJob,
    indexRepo,
    logger,
    updateRepositoryStatus,
    type IndexingJobData,
    type IndexingRunIdentity,
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
    createLegacyIndexingRunIdForJob: typeof createLegacyIndexingRunIdForJob;
    clearIndexingRuntimeStateBestEffort: typeof clearIndexingRuntimeStateBestEffort;
}

const defaultDeps: IndexingJobProcessorDeps = {
    indexRepo,
    updateRepositoryStatus,
    createLegacyIndexingRunIdForJob,
    clearIndexingRuntimeStateBestEffort,
};

async function persistAcceptedRun(
    job: Job<IndexingJobData>,
    indexingRun: IndexingRunIdentity
): Promise<void> {
    const acceptedData: IndexingJobData = {
        ...job.data,
        ...indexingRun,
        durablyAccepted: true,
    };
    // Failure finalization observes this Job instance immediately. Do not begin
    // indexing unless Redis also owns the identity: throwing here makes BullMQ
    // retry, and the next attempt recovers the durable owner before continuing.
    Object.assign(job.data, acceptedData);
    await job.updateData(acceptedData);
}

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
        const producerIdentity = typeof job.data.runId === 'string'
            && job.data.runId.length > 0;
        const stableJobId = job.id === undefined ? undefined : String(job.id);
        let indexingRun: IndexingRunIdentity | undefined = producerIdentity
            ? {
                runId: job.data.runId!,
                transitionAt: job.data.transitionAt
                    ?? new Date(job.timestamp ?? 0).toISOString(),
            }
            : stableJobId === undefined ? undefined : {
                runId: deps.createLegacyIndexingRunIdForJob(
                    repository,
                    baseBranch,
                    stableJobId
                ),
                transitionAt: new Date(job.timestamp ?? 0).toISOString(),
            };
        if (!indexingRun) {
            throw new Error('Identity-less indexing job has no stable BullMQ job ID');
        }
        if (!producerIdentity) {
            const transition = await deps.updateRepositoryStatus(
                repository,
                'indexing',
                baseBranch,
                { ...indexingRun, startNewRunIfIdle: true }
            );
            if (!transition.applied) {
                await deps.clearIndexingRuntimeStateBestEffort(
                    repository, baseBranch, indexingRun.runId
                );
                return { status: 'skipped', success: true };
            }
            indexingRun = { runId: transition.runId, transitionAt: transition.transitionAt };
            await persistAcceptedRun(job, indexingRun);
        } else {
            const transition = await deps.updateRepositoryStatus(
                repository,
                'indexing',
                baseBranch,
                { ...indexingRun, requireExistingRun: true }
            );
            if (!transition.applied) {
                if (job.data.durablyAccepted !== true) {
                    throw new Error('Indexing job is waiting for durable producer acceptance');
                }
                await deps.clearIndexingRuntimeStateBestEffort(
                    repository, baseBranch, indexingRun.runId
                );
                return { status: 'skipped', success: true };
            }
            indexingRun = { runId: transition.runId, transitionAt: transition.transitionAt };
            if (job.data.durablyAccepted !== true
                || job.data.transitionAt !== transition.transitionAt) {
                await persistAcceptedRun(job, indexingRun);
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
