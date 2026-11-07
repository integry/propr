import type { Logger } from 'pino';
import {
    findPlanIssueByRepoAndNumber,
    getEpicExecutionQueue,
    updatePlanIssueStatus,
    PlanIssueStatus,
    type IssueJobData,
} from '@propr/core';
import { completeIssueLabels, releasedTriggerLabels } from './issueJobCompletionLabels.js';
import {
    replaceNoChangeCompletion,
    retainNoChangeCompletion,
    type NoChangeCompletion,
    type RetainedNoChangeCompletion,
} from './noChangeCompletionObligation.js';

type Octokit = Parameters<typeof completeIssueLabels>[0]['octokit'];

/**
 * Records a no-change auto-merge completion. The status write notifies the plan's
 * execution queue, which alone selects and starts any successor.
 * @returns whether nothing further is owed: the status was written or none was due.
 */
async function markNoChangePlanIssueMerged(issueRef: IssueJobData, labels: string[], log: Logger): Promise<boolean> {
    try {
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        const planIssue = await findPlanIssueByRepoAndNumber(repository, issueRef.number);
        if (!planIssue || !planIssue.draft_id) {
            log.debug({ issueNumber: issueRef.number }, 'Issue is not part of a plan, skipping plan status update');
            return true;
        }

        const queue = await getEpicExecutionQueue(planIssue.draft_id);
        const queued = queue?.status === 'active' && queue.issues.includes(issueRef.number);
        if (!labels.includes('auto-merge') && !queued) {
            log.debug({ issueNumber: issueRef.number }, 'Issue does not have auto-merge label, skipping plan status update');
            return true;
        }

        await updatePlanIssueStatus(repository, issueRef.number, PlanIssueStatus.MERGED);
        log.info({ repository, issueNumber: issueRef.number }, 'Marked plan issue as merged (no changes needed)');
        return true;
    } catch (error) {
        log.warn({ issueNumber: issueRef.number, error: (error as Error).message }, 'Failed to mark no-change plan issue as merged');
        return false;
    }
}

/** Performs every step the held completion still owes, releasing it only once nothing is. */
async function settleNoChangeCompletion(
    octokit: Octokit, issueRef: IssueJobData, held: RetainedNoChangeCompletion, log: Logger,
): Promise<void> {
    const { record } = held;
    await completeIssueLabels({
        octokit, issueRef: { ...issueRef, triggeringLabel: record.triggeringLabel },
        AI_PROCESSING_TAG: record.processingTag, AI_DONE_TAG: record.doneTag, correlatedLogger: log,
    });
    let current: RetainedNoChangeCompletion | null = held;
    if (record.comment !== undefined) {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number, body: record.comment,
        });
        current = await replaceNoChangeCompletion(held, { ...record, comment: undefined });
        // A newer completion of this issue now owns the remaining steps.
        if (!current) return;
    }
    // A failed status write stays owed; the next job for this issue replays it.
    if (!await markNoChangePlanIssueMerged(issueRef, record.labels, log)) return;
    await replaceNoChangeCompletion(current, null);
}

export async function completeNoChangeIssue(options: {
    octokit: Octokit;
    issueRef: IssueJobData;
    labels: string[];
    comment: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlatedLogger: Logger;
}): Promise<void> {
    const { octokit, issueRef, labels, comment, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger } = options;
    const completion: Omit<NoChangeCompletion, 'id'> = {
        ...(issueRef.triggeringLabel ? { triggeringLabel: issueRef.triggeringLabel } : {}),
        processingTag: AI_PROCESSING_TAG, doneTag: AI_DONE_TAG, labels, comment,
    };
    // Retained before the done marker exists, so no moment has the marker without the record.
    const held = await retainNoChangeCompletion(issueRef, completion);
    await settleNoChangeCompletion(octokit, issueRef, held, correlatedLogger);
}

/**
 * Finishes a no-change completion whose done marker was published but whose
 * later steps failed, without rerunning the implementation. A record whose
 * marker is absent never published completion, so it is left for its own run.
 * @returns the labels the issue has after the replay.
 */
export async function replayNoChangeCompletion(options: {
    octokit: Octokit;
    issueRef: IssueJobData;
    currentLabels: string[];
    held: RetainedNoChangeCompletion;
    correlatedLogger: Logger;
}): Promise<string[]> {
    const { octokit, issueRef, currentLabels, held, correlatedLogger } = options;
    if (!currentLabels.includes(held.record.doneTag)) return currentLabels;
    correlatedLogger.info({ issueNumber: issueRef.number }, 'Finishing an interrupted no-change completion');
    await settleNoChangeCompletion(octokit, issueRef, held, correlatedLogger);
    const released = releasedTriggerLabels(held.record.triggeringLabel, held.record.processingTag);
    return currentLabels.filter(label => !released.includes(label));
}
