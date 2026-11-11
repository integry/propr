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
        publishComment: async body => {
            const comment = await updateComment(state, context, [normalCompletionHandoffMarkers(state.followupHandoff), context.publication.status, body].filter(Boolean).join('\n\n'));
            await markExecutionHandoffCommentPublished(state, comment.data.html_url);
            return comment;
        },
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
    taskId: string;
    stateManager: WorkerStateManager;
    jobData: CommentJobData;
    ref: { repoOwner: string; repoName: string; pullRequestNumber: number };
    ultrafixHistoryMeta?: Record<string, unknown>;
    correlatedLogger: Logger;
}

/** Publishes the blocker comment and ends the task as `blocked`. */
export async function settleBlockedFollowUp(input: BlockedFollowUpInput): Promise<BlockedRunOutcome> {
    const { report, worktreePath, claudeResult, unprocessedComments, authorsText, llm, taskUrl, requestedFeedback, publishComment, taskId, stateManager, jobData, ref, ultrafixHistoryMeta, correlatedLogger } = input;
    const outcome = await blockedRunOutcome(report, worktreePath, correlatedLogger);
    correlatedLogger.warn({ pullRequestNumber: ref.pullRequestNumber, uncommittedFiles: outcome.uncommittedFiles.length }, 'Agent reported a blocker; nothing will be committed or pushed');

    const body = await buildBlockedCompletionComment(unprocessedComments, outcome, { llm, authorsText, taskUrl, addressedFeedback: requestedFeedback }, claudeResult);
    const comment = await publishComment(body);
    const recap = blockedRunRecap(outcome);
    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'PR comment processing stopped on a reported blocker; nothing was committed or pushed',
        terminalReason: 'blocked',
        historyMetadata: {
            commandMode: jobData.commandMode || 'default',
            githubComment: { url: comment.data.html_url, body: comment.data.body },
            notificationRecap: recap,
            notificationSummary: recap,
            blocker: outcome,
            ...ultrafixHistoryMeta,
        },
    });
    await notifyBlockedRun({ taskId, repoOwner: ref.repoOwner, repoName: ref.repoName, number: ref.pullRequestNumber, kind: 'pull_request' }, outcome, correlatedLogger);
    return outcome;
}
