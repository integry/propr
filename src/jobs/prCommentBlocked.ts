/**
 * Follow-up and `/fix` runs that stop on a reported blocker
 * (`on_blocker: report`): nothing is committed or pushed, review findings stay
 * pending, and the completion comment states the blocker instead of the
 * no-change text. Loaded lazily, only for runs whose workflow enables the option.
 */
import type { Logger } from 'pino';
import { detectBlockerReport, TaskStates, type BlockerReport, type ClaudeCodeResponse, type CommentJobData, type UnprocessedComment, type WorkerStateManager } from '@propr/core';
import type { ReviewFeedbackSelection } from '@propr/shared';
import { buildBlockedCompletionComment } from './prCompletionComment.js';
import { blockedRunOutcome, blockedRunRecap, notifyBlockedRun, type BlockedRunOutcome } from './blockedRun.js';
import { normalCompletionHandoffMarkers } from './followupHandoffMarker.js';
import { markExecutionHandoffCommentPublished } from './prCommentHandoffIntegration.js';
import { selectedReviewFeedbackIds } from './reviewFindingSelector.js';
import { resolveUltrafixHistoryMeta } from './ultrafixJobHelpers.js';
import type { PostExecutionContext, PostExecutionParams, ReadyPostExecutionState } from './prCommentPostExecution.js';

type UpdateCompletionComment = (state: ReadyPostExecutionState, context: PostExecutionContext, body: string) => Promise<{ data: { html_url: string; body?: string } }>;

function isReady(state: PostExecutionParams['state']): state is ReadyPostExecutionState {
    return Boolean(state.claudeResult && state.octokit && state.startingWorkComment);
}

/**
 * Settles a follow-up whose agent ended normally with the blocker marker;
 * false (the normal publication runs) when there is no marker, the run did
 * not end normally, or this is a recovered publication, which already
 * committed its work before a restart.
 */
export async function settleReportedFollowUpBlocker(params: PostExecutionParams, taskUrl: string, updateComment: UpdateCompletionComment): Promise<boolean> {
    const { state, job, taskId, stateManager, context, unprocessedReviewComments, llm, redisClient } = params;
    if (params.recoveredCompletion || !isReady(state)) return false;
    const report = detectBlockerReport(state.claudeResult, true);
    if (!report) return false;
    const ref = { repoOwner: context.repoOwner, repoName: context.repoName, pullRequestNumber: context.pullRequestNumber };
    await settleBlockedFollowUp({
        report, worktreePath: state.worktreeInfo?.worktreePath, claudeResult: state.claudeResult,
        unprocessedComments: state.unprocessedComments, authorsText: state.authorsText, llm, taskUrl,
        requestedFeedback: selectedReviewFeedbackIds(unprocessedReviewComments),
        // The handoff marker lets restart recovery recognize this comment, as for a normal completion.
        publishComment: body => updateComment(state, context, [normalCompletionHandoffMarkers(state.followupHandoff), context.publication.status, body].filter(Boolean).join('\n\n')),
        checkpointCommentPublished: url => markExecutionHandoffCommentPublished(state, url),
        handoffOwnershipLost: () => Boolean(state.followupHandoffOwnershipLost),
        taskId, stateManager, jobData: job.data, ref,
        ultrafixHistoryMeta: await resolveUltrafixHistoryMeta(job, ref, redisClient),
        correlatedLogger: context.correlatedLogger,
    });
    return true;
}

export interface BlockedFollowUpInput {
    report: BlockerReport;
    worktreePath: string | undefined;
    claudeResult: ClaudeCodeResponse;
    unprocessedComments: UnprocessedComment[];
    authorsText: string;
    llm: string | null | undefined;
    taskUrl: string;
    /** Review records the `/fix` run was asked to apply; none were applied. */
    requestedFeedback?: ReviewFeedbackSelection;
    /** Publishes the completion comment (with the run's handoff markers) and returns it. */
    publishComment: (body: string) => Promise<{ data: { html_url: string; body?: string } }>;
    /** Records the delivered comment on the follow-up handoff. */
    checkpointCommentPublished: (commentUrl: string) => Promise<void>;
    /** True once a checkpoint observed a recovery successor adopt the handoff. */
    handoffOwnershipLost: () => boolean;
    taskId: string;
    stateManager: WorkerStateManager;
    jobData: CommentJobData;
    ref: { repoOwner: string; repoName: string; pullRequestNumber: number };
    ultrafixHistoryMeta?: Record<string, unknown>;
    correlatedLogger: Logger;
}

/**
 * How far the blocker's completion comment got. A comment that could not be
 * published, or whose handoff checkpoint could not be written, is recorded on
 * the task as outstanding instead of turning the blocked run into a failure.
 */
export interface BlockedFollowUpDelivery {
    completionComment: 'published' | 'failed';
    handoffCheckpoint: 'recorded' | 'failed' | 'skipped';
    error?: string;
}

async function deliverBlockerComment(input: BlockedFollowUpInput, body: string): Promise<{ comment: { data: { html_url: string; body?: string } } | null; delivery: BlockedFollowUpDelivery }> {
    const { publishComment, checkpointCommentPublished, handoffOwnershipLost, ref, correlatedLogger } = input;
    let comment: { data: { html_url: string; body?: string } };
    try {
        comment = await publishComment(body);
    } catch (error) {
        correlatedLogger.warn({ pullRequestNumber: ref.pullRequestNumber, error: (error as Error).message }, 'Could not publish the blocker comment; the run still ends blocked');
        return { comment: null, delivery: { completionComment: 'failed', handoffCheckpoint: 'skipped', error: (error as Error).message } };
    }
    try {
        await checkpointCommentPublished(comment.data.html_url);
    } catch (error) {
        // A recovery successor adopted the handoff: it owns the task's terminal
        // state and the handoff settlement, so this writer stops here.
        if (handoffOwnershipLost()) throw error;
        correlatedLogger.warn({ pullRequestNumber: ref.pullRequestNumber, error: (error as Error).message }, 'Could not record the published blocker comment on the follow-up handoff; the run still ends blocked');
        return { comment, delivery: { completionComment: 'published', handoffCheckpoint: 'failed', error: (error as Error).message } };
    }
    return { comment, delivery: { completionComment: 'published', handoffCheckpoint: 'recorded' } };
}

/**
 * Publishes the blocker comment and ends the task as `blocked`. A failed
 * comment or checkpoint is recorded as outstanding delivery and the task still
 * ends blocked; only lost handoff ownership stops this writer, because the
 * adopting successor then owns the terminal state.
 */
export async function settleBlockedFollowUp(input: BlockedFollowUpInput): Promise<BlockedRunOutcome> {
    const { report, worktreePath, claudeResult, unprocessedComments, authorsText, llm, taskUrl, requestedFeedback, taskId, stateManager, jobData, ref, ultrafixHistoryMeta, correlatedLogger } = input;
    const outcome = await blockedRunOutcome(report, worktreePath, correlatedLogger);
    correlatedLogger.warn({ pullRequestNumber: ref.pullRequestNumber, uncommittedFiles: outcome.uncommittedFiles.length }, 'Agent reported a blocker; nothing will be committed or pushed');

    const body = await buildBlockedCompletionComment(unprocessedComments, outcome, { llm, authorsText, taskUrl, addressedFeedback: requestedFeedback }, claudeResult);
    const { comment, delivery } = await deliverBlockerComment(input, body);
    if (input.handoffOwnershipLost()) throw new Error('Follow-up publication handoff ownership was lost before the blocked outcome was recorded');
    const recap = blockedRunRecap(outcome);
    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'PR comment processing stopped on a reported blocker; nothing was committed or pushed',
        terminalReason: 'blocked',
        historyMetadata: {
            commandMode: jobData.commandMode || 'default',
            ...(comment ? { githubComment: { url: comment.data.html_url, body: comment.data.body } } : {}),
            notificationRecap: recap,
            notificationSummary: recap,
            blocker: outcome,
            ...(delivery.handoffCheckpoint === 'recorded' ? {} : { blockerDelivery: delivery }),
            ...ultrafixHistoryMeta,
        },
    });
    await notifyBlockedRun({ taskId, repoOwner: ref.repoOwner, repoName: ref.repoName, number: ref.pullRequestNumber, kind: 'pull_request' }, outcome, correlatedLogger);
    return outcome;
}
