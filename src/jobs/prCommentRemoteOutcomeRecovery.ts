import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
    logger,
    type CommentJobData,
    type JobResult,
} from '@propr/core';
import { schedulePRCommentCleanupRecovery } from './prCommentCleanupRecovery.js';
import { clearRetainedPRProcessingLockToken } from './prCommentProcessingLease.js';
import { loadPRCommentRemoteOutcome } from './prCommentRemoteOutcome.js';

/** Recovers a remotely published result before a BullMQ retry can execute the agent again. */
export async function recoverPRCommentRemoteOutcome(
    redisClient: Pick<InstanceType<typeof Redis>, 'get'>,
    job: Job<CommentJobData>,
    taskId: string,
): Promise<JobResult | null> {
    const checkpoint = await loadPRCommentRemoteOutcome(redisClient, taskId);
    if (!checkpoint) return null;

    const correlatedLogger = logger.withCorrelation(job.data.correlationId);
    correlatedLogger.warn(
        { taskId, status: checkpoint.status },
        'Recovered a remotely committed PR outcome without rerunning the agent',
    );
    await schedulePRCommentCleanupRecovery({
        repoOwner: job.data.repoOwner,
        repoName: job.data.repoName,
        pullRequestNumber: job.data.pullRequestNumber,
        jobBranchName: job.data.branchName,
        jobLlm: job.data.llm,
        jobReasoningLevel: job.data.reasoningLevel,
        attemptGeneration: checkpoint.prProcessingAttemptGeneration as string,
        correlatedLogger,
    });
    await clearRetainedPRProcessingLockToken(job, taskId, correlatedLogger);
    return checkpoint;
}
