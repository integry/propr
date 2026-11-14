import { computePullRequestStatus } from './pullRequestStatus.js';
import { renderPullRequestStatusBlock } from './pullRequestStatusBlock.js';
import { isPullRequestStatusMaintained } from './pullRequestStatusSignal.js';

/**
 * The block a new ProPR pull request is created with, so the status is in the
 * body from the first moment: the creating task is still running. Null only
 * when this process does not maintain the status (library use and tests).
 */
export async function initialPullRequestStatusBlock(
    repository: string,
    options: {
        activity?: 'implementing' | 'follow_up'; now?: () => Date;
        /** A new epic: its progress, and the issue that starts next when known. */
        epic?: { merged: number; total: number; nextIssue?: number | null } | null;
    } = {},
): Promise<string | null> {
    if (!isPullRequestStatusMaintained()) return null;
    const type = options.activity === 'follow_up' ? 'pr-comment' : 'issue';
    const epic = options.epic;
    const status = computePullRequestStatus({
        pullRequest: { state: 'open', merged: false, headSha: '', mergeable: null },
        isProprPullRequest: true,
        // An epic's own branch is never implemented: it waits for its next issue.
        tasks: epic ? [] : [{ type, mode: type === 'pr-comment' ? 'follow_up' : null, state: 'post_processing', createdAt: new Date().toISOString() }],
        queuedJobs: 0, ultrafix: null,
        checks: { complete: true, passed: 0, failed: 0, pending: 0, failedNames: [] },
        latestReviewScore: null, ratingGoal: 0,
        epic: epic ? {
            merged: epic.merged, total: epic.total, nextIssueQueued: true,
            upNext: typeof epic.nextIssue === 'number' ? [{ issueNumber: epic.nextIssue, title: null }] : [],
        } : null,
    });
    return renderPullRequestStatusBlock(status, (options.now ?? (() => new Date()))());
}
