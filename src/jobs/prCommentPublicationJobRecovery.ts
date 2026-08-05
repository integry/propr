import { hashTaskAttemptToken, logger, type JobResult, type UnprocessedComment } from '@propr/core';
import type { Job } from 'bullmq';
import type { CommentJobData } from '@propr/core';
import type { PRJobContext } from './prCommentProcessingTypes.js';
import type { PRCommentPublicationCheckpoint } from './prCommentRemoteOutcome.js';
import {
    resumePRCommentPublication,
    type ResumePRCommentPublicationParams,
} from './prCommentPublicationRecovery.js';
import { handleUltrafixContinuation } from './ultrafixJobHelpers.js';

export function buildPRCommentPublicationRecoveryContext(
    job: Job<CommentJobData>,
): PRJobContext {
    const { pullRequestNumber, repoOwner, repoName, correlationId } = job.data;
    const commentsToProcess: UnprocessedComment[] = Array.isArray(job.data.comments)
        ? [...job.data.comments]
        : [];
    return {
        pullRequestNumber,
        jobBranchName: job.data.branchName,
        repoOwner,
        repoName,
        llm: job.data.llm,
        correlationId,
        correlatedLogger: logger.withCorrelation(correlationId),
        primaryProcessingLabels: [],
        isBatchJob: Array.isArray(job.data.comments),
        commentsToProcess,
    };
}

export async function resolvePRCommentJobContext(
    job: Job<CommentJobData>,
    checkpoint: PRCommentPublicationCheckpoint | null,
    initialize: (job: Job<CommentJobData>) => Promise<PRJobContext>,
): Promise<PRJobContext> {
    if (checkpoint) return buildPRCommentPublicationRecoveryContext(job);
    return await initialize(job);
}

export async function resumePRCommentPublicationJob(
    checkpoint: PRCommentPublicationCheckpoint,
    params: Omit<ResumePRCommentPublicationParams, 'beforeCompletion'> & { correlationId: string },
): Promise<JobResult> {
    const { context, correlationId } = params;
    const postResult = await resumePRCommentPublication(checkpoint, {
        ...params,
        beforeCompletion: () => handleUltrafixContinuation('fix', {
            job: params.job,
            stateManager: params.stateManager,
            taskId: params.taskId,
            redisClient: params.redisClient,
            repoOwner: context.repoOwner,
            repoName: context.repoName,
            pullRequestNumber: context.pullRequestNumber,
            correlatedLogger: context.correlatedLogger,
            correlationId,
            prProcessingLockToken: params.prProcessingLockToken,
            assertLease: params.assertLease,
        }),
    });
    return {
        status: postResult.partial ? 'partial' : 'complete',
        commit: postResult.commitHash,
        pullRequestNumber: context.pullRequestNumber,
        prProcessingAttemptGeneration: hashTaskAttemptToken(params.prProcessingLockToken),
    };
}
