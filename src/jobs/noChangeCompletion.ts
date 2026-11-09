import { randomUUID } from 'node:crypto';
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
    isCurrentNoChangeRequest,
    noChangeCompletionStillApplies,
    noChangeRequestId,
    replaceNoChangeCompletion,
    retainNoChangeCompletion,
    type NoChangeCompletion,
    type NoChangeCompletionStore,
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

/** How long a settler may hold the comment before another may take it over. */
export const NO_CHANGE_COMMENT_CLAIM_MS = 5 * 60 * 1000;

interface SettleOptions { log: Logger; store?: NoChangeCompletionStore; now?: () => number }

/** Ties a posted comment to one completion, so an uncertain post is found instead of repeated. */
export const noChangeCommentMarker = (record: NoChangeCompletion) => `<!-- propr-no-change-completion:${record.id} -->`;

/** Whether a comment carrying this completion's marker is already on the issue. */
async function commentAlreadyPosted(octokit: Octokit, issueRef: IssueJobData, record: NoChangeCompletion): Promise<boolean> {
    const marker = noChangeCommentMarker(record);
    // Comments posted for this completion cannot predate its retention (minus clock skew).
    const since = new Date(Math.max(0, (record.retainedAt ?? 0) - 60 * 60 * 1000)).toISOString();
    for (let page = 1; ; page += 1) {
        const { data } = await octokit.request<{ data: Array<{ body?: string | null }> }>(
            'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
            { owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number, since, per_page: 100, page },
        );
        if (data.some(comment => comment.body?.includes(marker))) return true;
        if (data.length < 100) return false;
    }
}

/**
 * Delivers the held completion's comment under an expiring claim. The comment
 * stays in the record until delivery is established, so a failed or
 * interrupted post leaves it owed, and a live claim keeps other settlers from
 * finalizing the record meanwhile.
 * @returns the record with the comment delivered; `null` when another settler owns the remaining steps.
 */
async function deliverNoChangeComment(
    octokit: Octokit, issueRef: IssueJobData, held: RetainedNoChangeCompletion, { store, now = Date.now }: SettleOptions,
): Promise<RetainedNoChangeCompletion | null> {
    const { record } = held;
    if (record.commentClaim && record.commentClaim.expiresAt > now()) return null;
    // An earlier claimant may have posted before failing or dying: reconcile before posting again.
    const uncertain = record.commentAttempted === true || record.commentClaim !== undefined;
    const claimed = await replaceNoChangeCompletion(held, {
        ...record, commentClaim: { token: randomUUID(), expiresAt: now() + NO_CHANGE_COMMENT_CLAIM_MS }, commentAttempted: true,
    }, store);
    if (!claimed) return null;
    try {
        if (!uncertain || !await commentAlreadyPosted(octokit, issueRef, record)) {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
                body: `${record.comment}\n\n${noChangeCommentMarker(record)}`,
            });
        }
    } catch (error) {
        // Release the claim so a later replay retries promptly; if this fails the claim expires instead.
        await replaceNoChangeCompletion(claimed, { ...claimed.record, commentClaim: undefined }, store).catch(() => null);
        throw error;
    }
    // A claimant whose lease lapsed loses this step; its successor finds the marker and finishes.
    return replaceNoChangeCompletion(claimed, { ...claimed.record, comment: undefined, commentClaim: undefined }, store);
}

/** Drops a completion whose request was superseded by renewed work; @returns whether it was. */
async function dropIfSuperseded(issueRef: IssueJobData, held: RetainedNoChangeCompletion, { log, store }: SettleOptions): Promise<boolean> {
    if (await isCurrentNoChangeRequest(issueRef, held.record, store)) return false;
    log.info({ issueNumber: issueRef.number, requestId: held.record.requestId },
        'Dropping a no-change completion superseded by a newer request for the issue');
    await replaceNoChangeCompletion(held, null, store);
    return true;
}

/**
 * Performs every step the held completion still owes, releasing it only once nothing is.
 * @returns whether the completion still applied, so its trigger labels were released.
 */
async function settleNoChangeCompletion(
    octokit: Octokit, issueRef: IssueJobData, held: RetainedNoChangeCompletion, options: SettleOptions,
): Promise<boolean> {
    const { log, store } = options;
    const { record } = held;
    // Each mutation re-checks that this completion still answers the issue's newest request.
    if (await dropIfSuperseded(issueRef, held, options)) return false;
    const labels = await completeIssueLabels({
        octokit, issueRef: { ...issueRef, triggeringLabel: record.triggeringLabel },
        AI_PROCESSING_TAG: record.processingTag, AI_DONE_TAG: record.doneTag, correlatedLogger: log,
        stillApplies: () => noChangeCompletionStillApplies(issueRef, held, store),
    });
    if (labels.superseded) {
        log.info({ issueNumber: issueRef.number, requestId: record.requestId },
            'Abandoning a no-change completion superseded while its labels were being settled');
        await dropIfSuperseded(issueRef, held, options);
        return false;
    }
    let current: RetainedNoChangeCompletion | null = held;
    if (record.comment !== undefined) {
        current = await deliverNoChangeComment(octokit, issueRef, held, options);
        // Another settler holds the comment (or won it), and it finalizes the record;
        // a record admission dropped for a newer request is no longer this settlement's.
        if (!current) return isCurrentNoChangeRequest(issueRef, record, store);
    }
    if (await dropIfSuperseded(issueRef, current, options)) return true;
    // A failed status write stays owed; the next job for this issue, or recovery, replays it.
    if (await markNoChangePlanIssueMerged(issueRef, record.labels, log)) await replaceNoChangeCompletion(current, null, store);
    return true;
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
        ...(noChangeRequestId(issueRef) ? { requestId: noChangeRequestId(issueRef) } : {}),
        processingTag: AI_PROCESSING_TAG, doneTag: AI_DONE_TAG, labels, comment,
    };
    // Retained before the done marker exists, so no moment has the marker without the record.
    const held = await retainNoChangeCompletion(issueRef, completion);
    await settleNoChangeCompletion(octokit, issueRef, held, { log: correlatedLogger });
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
    store?: NoChangeCompletionStore;
    now?: () => number;
}): Promise<string[]> {
    const { octokit, issueRef, currentLabels, held, correlatedLogger, store, now } = options;
    if (!currentLabels.includes(held.record.doneTag)) return currentLabels;
    correlatedLogger.info({ issueNumber: issueRef.number }, 'Finishing an interrupted no-change completion');
    if (!await settleNoChangeCompletion(octokit, issueRef, held, { log: correlatedLogger, store, now })) return currentLabels;
    const released = releasedTriggerLabels(held.record.triggeringLabel, held.record.processingTag);
    return currentLabels.filter(label => !released.includes(label));
}
