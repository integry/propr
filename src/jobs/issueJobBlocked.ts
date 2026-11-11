/**
 * Issue runs that stop on a reported blocker (`on_blocker: report`): nothing
 * is committed or opened, the done label is not added and the plan issue is
 * left as it is. The issue gets a comment quoting the agent's explanation.
 * Loaded lazily, only for runs whose workflow enables the option.
 */
import type { Logger } from 'pino';
import {
    clearEpicQueueHeadBlocked, detectBlockerReport, findPlanIssueByRepoAndNumber, markEpicQueueHeadBlocked, safeUpdateLabels,
    type BlockerReport, type ClaudeCodeResponse, type IssueJobData,
} from '@propr/core';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { blockedRunOutcome, describeUncommittedFiles, notifyBlockedRun, quoteBlockerExplanation, type BlockedRunOutcome } from './blockedRun.js';

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

export interface IssueBlockerOptions {
    octokit: Octokit;
    issueRef: IssueJobData;
    worktreePath: string;
    report: BlockerReport;
    AI_PROCESSING_TAG: string;
    correlatedLogger: Logger;
    taskId?: string;
}

function taskLink(taskId: string | undefined): string {
    if (!taskId) return '';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return `\n\n[View Task Execution](${frontendUrl}/tasks/${encodeURIComponent(taskId)})`;
}

export function buildIssueBlockerComment(outcome: BlockedRunOutcome, taskId?: string): string {
    const uncommitted = describeUncommittedFiles(outcome.uncommittedFiles);
    return [
        '🛑 **AI processing stopped on a blocker.**',
        'The agent could not complete this issue as specified and reported a blocker instead of delivering a reduced version. Nothing was committed and no pull request was opened.',
        `**What blocked the run:**\n\n${quoteBlockerExplanation(outcome.explanation)}`,
        uncommitted,
        'Resolve the blocker (for example, by updating the issue with what is needed), then request processing again.',
    ].filter(Boolean).join('\n\n') + taskLink(taskId);
}

/**
 * Settles the run when its agent ended normally with the blocker marker;
 * null (the normal commit path runs) otherwise. Settling never throws, so a
 * blocked run cannot fall back to the done-marking failure path.
 */
export async function settleReportedIssueBlocker(options: Omit<IssueBlockerOptions, 'report' | 'worktreePath'> & { claudeResult: ClaudeCodeResponse; worktreeInfo: { worktreePath: string } }): Promise<PostProcessingResult | null> {
    const report = detectBlockerReport(options.claudeResult, true);
    if (!report) return null;
    try {
        return await handleIssueBlocker({ ...options, report, worktreePath: options.worktreeInfo.worktreePath });
    } catch (error) {
        options.correlatedLogger.warn({ issueNumber: options.issueRef.number, error: (error as Error).message }, 'Could not fully settle a blocked run; it still ends blocked');
        return { success: false, pr: null, updatedLabels: [], blocked: { explanation: report.explanation, uncommittedFiles: [] } };
    }
}

/**
 * Settles a run whose agent reported a blocker. GitHub and Inbox updates are
 * best-effort: the task still ends blocked, and is never marked done, when
 * one of them fails.
 */
export async function handleIssueBlocker(options: IssueBlockerOptions): Promise<PostProcessingResult> {
    const { octokit, issueRef, worktreePath, report, AI_PROCESSING_TAG, correlatedLogger, taskId } = options;
    const outcome = await blockedRunOutcome(report, worktreePath, correlatedLogger);
    correlatedLogger.warn({ issueNumber: issueRef.number, uncommittedFiles: outcome.uncommittedFiles.length }, 'Agent reported a blocker; nothing will be committed');

    // The done label is never added: the work was not done.
    try {
        const labelUpdate = await safeUpdateLabels(
            { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
            [AI_PROCESSING_TAG],
            [],
        );
        if (!labelUpdate.success) correlatedLogger.warn({ issueNumber: issueRef.number, errors: labelUpdate.errors }, 'Could not remove the processing label from a blocked issue');
    } catch (error) {
        correlatedLogger.warn({ issueNumber: issueRef.number, error: (error as Error).message }, 'Could not remove the processing label from a blocked issue');
    }

    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
            body: buildIssueBlockerComment(outcome, taskId),
        });
    } catch (error) {
        correlatedLogger.warn({ issueNumber: issueRef.number, error: (error as Error).message }, 'Could not post the blocker comment');
    }
    if (taskId) {
        await notifyBlockedRun({ taskId, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, number: issueRef.number, kind: 'issue' }, outcome, correlatedLogger);
    }
    return { success: false, pr: null, updatedLabels: [], blocked: outcome };
}

/**
 * Keeps the plan's epic execution queue in step with the run's outcome. A
 * blocked run holds its queued issue (the plan issue stays in progress), so the
 * queue records why the epic stands still; a later run for the issue that
 * settles without a blocker drops that explanation, and its merge or no-change
 * completion advances the queue as usual. Best-effort: never throws.
 */
export async function syncEpicQueueBlocker({ issueRef, blocked, correlatedLogger }: {
    issueRef: Pick<IssueJobData, 'repoOwner' | 'repoName' | 'number'>; blocked: boolean; correlatedLogger: Logger;
}): Promise<void> {
    const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
    try {
        const planIssue = await findPlanIssueByRepoAndNumber(repository, issueRef.number);
        if (!planIssue?.draft_id) return;
        const target = { draftId: planIssue.draft_id, issueNumber: issueRef.number };
        if (blocked) {
            if (await markEpicQueueHeadBlocked(target)) {
                correlatedLogger.info({ repository, ...target }, 'Epic execution queue is held by a blocked issue');
            }
        } else if (await clearEpicQueueHeadBlocked(target)) {
            correlatedLogger.info({ repository, ...target }, 'Cleared the blocker on the epic execution queue after a normal run');
        }
    } catch (error) {
        correlatedLogger.warn({ repository, issueNumber: issueRef.number, error: (error as Error).message },
            'Could not update the epic execution queue for the run outcome');
    }
}
