import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
    ensureGitRepository, TaskStates,
    type getAuthenticatedOctokit, type WorkerStateManager, type WorktreeInfo,
    type ClaudeCodeResponse, type CommentJobData, type UnprocessedComment, type JobResult,
} from '@propr/core';
import type { PRJobContext } from './prCommentReviewJob.js';
import { createPRCommentTaskStateIfMissing } from './prCommentCollisionRecovery.js';
import { handlePostExecution, type PublicationCompletion } from './prCommentPostExecution.js';
import { restorePendingComments } from './prPendingComments.js';
import { stopOriginalPRReviewCycle } from './prContinuationReview.js';
import { handleUltrafixContinuation } from './ultrafixJobHelpers.js';
import { PullRequestPublication } from './prPublication.js';
import { findPRContinuation, savePublicationCheckpoint, type ContinuationRecord, type Contribution } from './prContinuation.js';
import { sanitizeErrorMessage } from './errorSanitizer.js';

const TERMINAL_STATES: ReadonlySet<string> = new Set([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);

export interface ProcessingState {
    publication?: PullRequestPublication;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    localRepoPath: string | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    claudeResult: ClaudeCodeResponse | null;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    startingWorkComment: { data: { id: number; html_url: string } } | null;
}

export interface ExecuteProcessingParams {
    job: Job<CommentJobData>;
    context: PRJobContext;
    llm: string | null | undefined;
    taskId: string;
    stateManager: WorkerStateManager;
    state: ProcessingState;
    lockKey: string;
    lockToken: string;
}

/** Reads the saved checkpoint and retires a cancelled one. No Git or GitHub work happens here. */
async function loadPendingPublication(
    { context, stateManager }: Pick<ExecuteProcessingParams, 'context' | 'stateManager'>,
): Promise<{ record: ContinuationRecord; completion?: PublicationCompletion } | undefined> {
    const record = await findPRContinuation(context);
    if (!record?.publication_bundle && !record?.publication_completion) return;
    const completion = record.publication_completion
        ? JSON.parse(record.publication_completion) as PublicationCompletion : undefined;
    if (completion && (await stateManager.getTaskState(completion.taskId))?.state === TaskStates.CANCELLED) {
        // Retire both inputs before any reconciliation or preparation. A later
        // request's prepare() must not restore work the originating user cancelled.
        await savePublicationCheckpoint(record, null, null);
        context.correlatedLogger.info({ taskId: completion.taskId }, 'Retired cancelled publication checkpoint');
        return;
    }
    return { record, completion };
}

async function preparePendingPublication(
    { state, context }: Pick<ExecuteProcessingParams, 'state' | 'context'>, record: ContinuationRecord,
): Promise<PullRequestPublication> {
    const octokit = state.octokit!;
    // Completion alone uses the retained destination and task metadata, even after
    // the continuation is merged and its branch is deleted.
    const source = record.publication_bundle ? (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: context.repoOwner, repo: context.repoName, pull_number: context.pullRequestNumber,
    })).data as Contribution : {
        head: { ref: record.branch_name, sha: record.source_sha, repo: { full_name: record.repository } },
        base: { ref: record.base_branch }, title: record.source_title,
        body: record.source_body, user: { login: record.source_author },
    };
    const publication = state.publication = new PullRequestPublication(octokit, context, source as Contribution);
    publication.continuation = record;
    await publication.reconcilePublication();
    if (publication.continuation.publication_bundle) {
        await ensureGitRepository(context.correlatedLogger);
        const prepared = await publication.prepare(`pr-${context.pullRequestNumber}-publication-${Date.now()}`);
        state.localRepoPath = prepared.localRepoPath;
        state.worktreeInfo = prepared.worktreeInfo;
    } else {
        await publication.announce();
    }
    return publication;
}

/**
 * The job's error handler only finalizes the triggering task. When it recovers another
 * task's completion, that task was moved back to PROCESSING and nothing else closes its
 * attempt, so it is finalized here before the error reaches the job.
 */
async function finalizeOriginatingTask({ stateManager, context, taskId }: ExecuteProcessingParams, originatingTaskId: string, error: Error): Promise<void> {
    try {
        const current = await stateManager.getTaskState(originatingTaskId);
        if (!current || TERMINAL_STATES.has(current.state)) {
            context.correlatedLogger.info({ taskId: originatingTaskId, currentState: current?.state ?? null }, 'Originating task already final after recovery failure, skipping state update');
            return;
        }
        // Cancelling the recovering request does not cancel the originating task: a
        // CANCELLED originating task retires its checkpoint on the next attempt, while
        // FAILED keeps the published work recoverable by a later request.
        const cancelled = error.message?.includes('aborted by user');
        await stateManager.updateTaskState(originatingTaskId, TaskStates.FAILED, {
            reason: cancelled ? 'Publication recovery was cancelled by user' : 'Publication recovery failed',
            error: { message: sanitizeErrorMessage(error.message) },
            historyMetadata: { recoveredByTaskId: taskId },
        });
        context.correlatedLogger.info({ taskId: originatingTaskId, recoveredByTaskId: taskId }, 'Marked originating task as failed after recovery failure');
    } catch (finalizeError) {
        context.correlatedLogger.error({ taskId: originatingTaskId, error: (finalizeError as Error).message }, 'Failed to finalize originating task after recovery failure');
    }
}

/** Recover under the shared PR lease, before comment filtering or review routing can skip completion. */
export async function recoverPendingPublication(params: ExecuteProcessingParams, redisClient: Redis): Promise<JobResult | undefined> {
    const pending = await loadPendingPublication(params);
    if (!pending) return;
    const originatingTaskId = pending.completion?.taskId;
    try {
        return await completePendingPublication(params, redisClient, pending);
    } catch (error) {
        if (originatingTaskId && originatingTaskId !== params.taskId) await finalizeOriginatingTask(params, originatingTaskId, error as Error);
        throw error;
    }
}

async function completePendingPublication(
    params: ExecuteProcessingParams, redisClient: Redis, pending: NonNullable<Awaited<ReturnType<typeof loadPendingPublication>>>,
): Promise<JobResult | undefined> {
    const { state, context, taskId, job, stateManager, lockKey, lockToken } = params;
    const octokit = state.octokit!;
    const saved = pending.completion;
    if (saved) {
        // Source lookup, reconciliation, continuation creation and Git publication can
        // all fail below. The job's error handler must already know the originating
        // comment, and the same task's retry must no longer sit in its earlier FAILED
        // state, or that comment never receives the recovery failure.
        Object.assign(state, {
            authorsText: saved.authorsText, unprocessedComments: saved.unprocessedComments,
            startingWorkComment: saved.startingWorkComment,
        });
        const originalState = await stateManager.getTaskState(saved.taskId);
        await createPRCommentTaskStateIfMissing({
            job: { ...job, id: saved.taskId, data: saved.jobData } as Job<CommentJobData>, taskId: saved.taskId,
            stateManager, preexistingState: originalState,
            modelName: saved.llm ?? null, correlatedLogger: context.correlatedLogger,
        });
        if (originalState?.state === TaskStates.FAILED) await stateManager.updateTaskState(saved.taskId, TaskStates.PROCESSING, {
            reason: 'Retrying publication completion for the originating task', isRetry: true,
        });
    }
    const publication = await preparePendingPublication(params, pending.record);
    // Publication can update the saved commit hash; read the completion again.
    const completion = publication.pendingCompletion;
    if (!completion) return; // Legacy bundles can be published but have no completion inputs.
    state.claudeResult = completion.claudeResult;
    const originalJob = { ...job, id: completion.taskId, data: completion.jobData } as Job<CommentJobData>;
    const originalContext = { ...context, ...completion.jobData, publication };
    const result = await handlePostExecution({
        state, job: originalJob, taskId: completion.taskId, stateManager, context: originalContext,
        unprocessedReviewComments: completion.unprocessedReviewComments, llm: completion.llm,
        redisClient, prProcessingLockKey: lockKey, prProcessingLockToken: lockToken,
        recoveredCompletion: completion,
    }, completion.taskUrl);
    const stopped = await stopOriginalPRReviewCycle({
        ref: originalContext, continuation: publication.continuation, commandMode: originalJob.data.commandMode,
        ultrafix: Boolean(originalJob.data.ultrafixMeta), redis: redisClient, octokit,
    });
    if (!stopped) await handleUltrafixContinuation('fix', {
        job: originalJob, stateManager, taskId: completion.taskId, redisClient,
        repoOwner: originalContext.repoOwner, repoName: originalContext.repoName,
        pullRequestNumber: originalContext.pullRequestNumber, correlatedLogger: context.correlatedLogger,
        correlationId: originalContext.correlationId,
    });
    const completedIds = new Set(completion.instructionCommentIds);
    context.commentsToProcess = context.commentsToProcess.filter(comment => !completedIds.has(comment.id));
    if (taskId === completion.taskId && context.commentsToProcess.length > 0) {
        // Newly claimed comments need their own task after this retry completes.
        // cleanupJob schedules them from the pending list.
        await restorePendingComments(context.commentsToProcess, { ...context, redisClient });
        context.commentsToProcess = [];
    }
    if (taskId !== completion.taskId && (await stateManager.getTaskState(taskId))?.state === TaskStates.FAILED) {
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
            reason: 'Retrying request after publication recovery', isRetry: true,
        });
    }
    if (context.commentsToProcess.length === 0) {
        if (taskId !== completion.taskId) await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: 'Recovered publication and completion of the originating task', commitHash: result.commitHash,
            historyMetadata: { recoveryOfTaskId: completion.taskId },
        });
        await publication.finishCompletion();
        return { status: result.partial ? 'partial' : 'complete', commit: result.commitHash,
            pullRequestNumber: context.pullRequestNumber, claudeResult: { success: completion.claudeResult.success } };
    }
    await publication.finishCompletion();
    // A new request continues on the recovered HEAD with only its remaining instructions.
    state.claudeResult = null;
    state.startingWorkComment = null;
    state.unprocessedComments = [];
    state.authorsText = '';
}
