import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
    db,
    getAuthenticatedOctokit,
    hashTaskAttemptToken,
    SupersededTaskAttemptError,
    TaskStates,
    type CommentJobData,
    type WorkerStateManager,
} from '@propr/core';
import { schedulePRCommentCleanupRecovery } from './prCommentJobUtils.js';
import {
    clearPRCommentPublicationCheckpoint,
    persistPRCommentPublicationCheckpoint,
    persistPRCommentRemoteOutcome,
    type PRCommentPublicationCheckpoint,
    type PRCommentPublicationStage,
} from './prCommentRemoteOutcome.js';
import { markReviewCommentsProcessed } from './reviewCommentGatherer.js';
import { resolveUltrafixHistoryMeta } from './ultrafixJobHelpers.js';

export interface PRCommentPublicationContext {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    correlatedLogger: Logger;
}

export interface PRCommentPublicationExecution {
    job: Job<CommentJobData>;
    taskId: string;
    stateManager: WorkerStateManager;
    context: PRCommentPublicationContext;
    llm: string | null | undefined;
    redisClient: Redis;
    prProcessingLockToken: string;
    assertLease: () => Promise<void>;
    beforeCompletion: () => Promise<void>;
}

export interface PRCommentPublicationState {
    branchName: string;
    claudeSuccess: boolean;
    commitHash?: string;
    completionComment: { id: number; htmlUrl: string; body: string };
    reviewCommentIds: number[];
    partial: boolean;
    terminationReason?: string;
}

export interface ResumePRCommentPublicationParams extends PRCommentPublicationExecution {
    signal: AbortSignal;
}

const PUBLICATION_STAGE_INDEX: Record<PRCommentPublicationStage, number> = {
    push_pending: 0,
    branch_pushed: 1,
    completion_comment_published: 2,
    review_comments_processed: 3,
    continuation_handled: 4,
    commit_hash_persisted: 5,
};

function buildPublicationResult(
    execution: PRCommentPublicationExecution,
    publication: PRCommentPublicationState,
) {
    return {
        status: publication.partial ? 'partial' : 'complete',
        commit: publication.commitHash,
        pullRequestNumber: execution.context.pullRequestNumber,
        claudeResult: { success: publication.claudeSuccess },
        prProcessingAttemptGeneration: hashTaskAttemptToken(execution.prProcessingLockToken),
    };
}

export async function checkpointPRCommentPublication(
    execution: PRCommentPublicationExecution,
    publication: PRCommentPublicationState,
    stage: PRCommentPublicationStage,
): Promise<void> {
    const { repoOwner, repoName, pullRequestNumber } = execution.context;
    const result = buildPublicationResult(execution, publication);
    await persistPRCommentPublicationCheckpoint(execution.redisClient, {
        taskId: execution.taskId,
        lockKey: `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`,
        lockToken: execution.prProcessingLockToken,
        checkpoint: {
            kind: 'implementation-publication',
            stage,
            prProcessingAttemptGeneration: result.prProcessingAttemptGeneration,
            result,
            branchName: publication.branchName,
            completionComment: {
                id: publication.completionComment.id,
                body: publication.completionComment.body,
                htmlUrl: publication.completionComment.htmlUrl || undefined,
            },
            reviewCommentIds: publication.reviewCommentIds,
            ...(publication.terminationReason && { terminationReason: publication.terminationReason }),
        },
    });
}

async function persistCommitHash(
    taskId: string,
    commitHash: string | undefined,
    prProcessingLockToken: string,
    correlatedLogger: Logger,
): Promise<void> {
    if (!commitHash) return;
    try {
        const updatedRows = await db('tasks')
            .where({ task_id: taskId })
            .andWhere('attempt_generation', hashTaskAttemptToken(prProcessingLockToken))
            .update({ commit_hash: commitHash });
        if (updatedRows !== 1) throw new SupersededTaskAttemptError(taskId);
        correlatedLogger.info({ taskId, commitHash }, 'Saved commit hash to tasks table');
    } catch (dbError) {
        if (dbError instanceof SupersededTaskAttemptError) throw dbError;
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database; publication recovery will retry');
        throw dbError;
    }
}

export async function finalizePRCommentPublication(
    execution: PRCommentPublicationExecution,
    publication: PRCommentPublicationState,
    initialStage: PRCommentPublicationStage,
): Promise<void> {
    const {
        job, taskId, stateManager, context, llm,
        redisClient, prProcessingLockToken, assertLease, beforeCompletion,
    } = execution;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = context;
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;
    let completedStage = initialStage;
    const persistStage = async (stage: PRCommentPublicationStage): Promise<void> => {
        await checkpointPRCommentPublication(execution, publication, stage);
        completedStage = stage;
    };

    if (PUBLICATION_STAGE_INDEX[completedStage] < PUBLICATION_STAGE_INDEX.review_comments_processed) {
        if (publication.reviewCommentIds.length > 0) {
            await assertLease();
            await markReviewCommentsProcessed(publication.reviewCommentIds, {
                repoOwner,
                repoName,
                pullRequestNumber,
                redisClient,
                correlatedLogger,
                prProcessingLockKey: lockKey,
                prProcessingLockToken,
                assertLease,
            });
        }
        await persistStage('review_comments_processed');
    }

    if (PUBLICATION_STAGE_INDEX[completedStage] < PUBLICATION_STAGE_INDEX.continuation_handled) {
        await beforeCompletion();
        await persistStage('continuation_handled');
    }
    const ultrafixHistoryMeta = await resolveUltrafixHistoryMeta(
        job,
        { repoOwner, repoName, pullRequestNumber },
        redisClient,
    );
    if (PUBLICATION_STAGE_INDEX[completedStage] < PUBLICATION_STAGE_INDEX.commit_hash_persisted) {
        await assertLease();
        await persistCommitHash(taskId, publication.commitHash, prProcessingLockToken, correlatedLogger);
        await persistStage('commit_hash_persisted');
    }

    const result = buildPublicationResult(execution, publication);
    await persistPRCommentRemoteOutcome(redisClient, {
        taskId,
        lockKey,
        lockToken: prProcessingLockToken,
        result,
    });
    await schedulePRCommentCleanupRecovery({
        repoOwner,
        repoName,
        pullRequestNumber,
        jobBranchName: publication.branchName,
        jobLlm: llm,
        jobReasoningLevel: job.data.reasoningLevel,
        attemptGeneration: result.prProcessingAttemptGeneration,
        correlatedLogger,
    });
    await assertLease();
    try {
        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: publication.partial ? 'PR comment processing published partial work after interrupted execution' : 'PR comment processing completed successfully',
            commitHash: publication.commitHash,
            historyMetadata: {
                commandMode: job.data.commandMode || 'default',
                githubComment: { url: publication.completionComment.htmlUrl, body: publication.completionComment.body },
                ...(publication.reviewCommentIds.length > 0 && { consumedReviewCommentIds: publication.reviewCommentIds }),
                ...(publication.partial && { incompleteExecution: { reason: publication.terminationReason } }),
                ...ultrafixHistoryMeta,
            }
        }, prProcessingLockToken);
    } catch (error) {
        correlatedLogger.warn(
            { taskId, error: (error as Error).message },
            'Deferred terminal task-state persistence after committing the remote PR outcome',
        );
    }
}

function publicationFromCheckpoint(
    checkpoint: PRCommentPublicationCheckpoint,
): PRCommentPublicationState {
    const result = checkpoint.result;
    return {
        branchName: checkpoint.branchName,
        claudeSuccess: (result.claudeResult as { success?: unknown } | undefined)?.success === true,
        commitHash: typeof result.commit === 'string' ? result.commit : undefined,
        completionComment: {
            id: checkpoint.completionComment.id,
            body: checkpoint.completionComment.body,
            htmlUrl: checkpoint.completionComment.htmlUrl || '',
        },
        reviewCommentIds: checkpoint.reviewCommentIds,
        partial: result.status === 'partial',
        terminationReason: checkpoint.terminationReason,
    };
}

async function adoptPublicationCheckpoint(
    checkpoint: PRCommentPublicationCheckpoint,
    params: ResumePRCommentPublicationParams,
): Promise<void> {
    const adoptedGeneration = hashTaskAttemptToken(params.prProcessingLockToken);
    await persistPRCommentPublicationCheckpoint(params.redisClient, {
        taskId: params.taskId,
        lockKey: `lock:pr:${params.context.repoOwner}:${params.context.repoName}:${params.context.pullRequestNumber}`,
        lockToken: params.prProcessingLockToken,
        checkpoint: {
            ...checkpoint,
            prProcessingAttemptGeneration: adoptedGeneration,
            result: { ...checkpoint.result, prProcessingAttemptGeneration: adoptedGeneration },
        },
    });
}

function isNotFoundError(error: unknown): boolean {
    return (error as { status?: unknown }).status === 404;
}

async function remoteBranchContainsCommit(
    checkpoint: PRCommentPublicationCheckpoint,
    params: ResumePRCommentPublicationParams,
): Promise<boolean> {
    const commitHash = checkpoint.result.commit as string;
    const octokit = await getAuthenticatedOctokit();
    await params.assertLease();
    let remoteHead: string;
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
            owner: params.context.repoOwner,
            repo: params.context.repoName,
            ref: `heads/${checkpoint.branchName}`,
            request: { signal: params.signal },
        }) as { data: { object: { sha: string } } };
        remoteHead = response.data.object.sha;
    } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
    }
    if (remoteHead === commitHash) return true;

    try {
        const comparison = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner: params.context.repoOwner,
            repo: params.context.repoName,
            basehead: `${commitHash}...${checkpoint.branchName}`,
            request: { signal: params.signal },
        }) as { data: { status: string } };
        return comparison.data.status === 'ahead' || comparison.data.status === 'identical';
    } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
    }
}

/** Resumes publication side effects from the last generation-fenced checkpoint. */
export async function resumePRCommentPublication(
    checkpoint: PRCommentPublicationCheckpoint,
    params: ResumePRCommentPublicationParams,
): Promise<{ commitHash?: string; partial: boolean } | null> {
    const { context, taskId, assertLease, signal } = params;
    const publication = publicationFromCheckpoint(checkpoint);

    if (checkpoint.stage === 'push_pending') {
        const branchContainsCommit = await remoteBranchContainsCommit(checkpoint, params);
        await assertLease();
        if (!branchContainsCommit) {
            await clearPRCommentPublicationCheckpoint(params.redisClient, {
                taskId,
                lockKey: `lock:pr:${context.repoOwner}:${context.repoName}:${context.pullRequestNumber}`,
                lockToken: params.prProcessingLockToken,
            });
            context.correlatedLogger.warn(
                { taskId, commitHash: publication.commitHash, branchName: publication.branchName },
                'Discarded an uncommitted pre-push checkpoint; the agent attempt will rerun',
            );
            return null;
        }
        checkpoint = { ...checkpoint, stage: 'branch_pushed' };
    }
    await adoptPublicationCheckpoint(checkpoint, params);

    let completedStage = checkpoint.stage;
    if (completedStage === 'branch_pushed') {
        const octokit = await getAuthenticatedOctokit();
        await assertLease();
        const completionComment = await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: context.repoOwner,
            repo: context.repoName,
            comment_id: publication.completionComment.id,
            body: publication.completionComment.body,
            request: { signal },
        }) as { data: { html_url: string; body?: string } };
        publication.completionComment.htmlUrl = completionComment.data.html_url;
        publication.completionComment.body = completionComment.data.body ?? publication.completionComment.body;
        await checkpointPRCommentPublication(params, publication, 'completion_comment_published');
        completedStage = 'completion_comment_published';
    }

    context.correlatedLogger.warn(
        { taskId, completedStage, commitHash: publication.commitHash },
        'Resuming staged PR publication without rerunning the agent',
    );
    await finalizePRCommentPublication(params, publication, completedStage);
    return { commitHash: publication.commitHash, partial: publication.partial };
}
