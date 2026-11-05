import type { Logger } from 'pino';
import type { WorkerStateManager } from '@propr/core';
import { autoAssignImplementationPullRequest, recordAutoAssignmentEvent, type AutoAssignmentClaimStore, type LinkedIssueReference } from '../github/prAutoAssignment.js';
import type { ContinuationRecord } from './prContinuation.js';

export interface FollowUpAssignmentContext {
    octokit: { request: <T = unknown>(route: string, parameters: Record<string, unknown>) => Promise<T> };
    repoOwner: string;
    repoName: string;
    /** The pull request the follow-up was requested on. */
    pullRequestNumber: number;
    /** Set when the work was published to a continuation pull request instead. */
    continuation?: Pick<ContinuationRecord, 'continuation_pr'>;
    commandMode?: string;
    /** The commit the follow-up pushed; absent when it produced none. */
    commit: { commitHash?: string } | null | undefined;
    /** The source issue the pull request closes, when the job already resolved it. */
    linkedIssue?: LinkedIssueReference | null;
    taskId: string;
    stateManager: Pick<WorkerStateManager, 'getTaskState' | 'updateTaskState'>;
    redis: AutoAssignmentClaimStore;
    logger: Logger;
}

/**
 * Re-assigns a pull request once a follow-up published a commit to it, per the
 * repository's auto-assignment policy, and records the decision on the task
 * timeline. Work starting never reaches here, and neither does a `/review` run
 * or a follow-up without a commit, since neither changes the pull request.
 * The commit keys the idempotency guard, so each commit is one opportunity.
 * Never fails the follow-up.
 */
export async function autoAssignFollowUpPullRequest(context: FollowUpAssignmentContext): Promise<void> {
    const { commit, commandMode, taskId, stateManager, logger } = context;
    if (!commit || commandMode === 'review') return;
    const prNumber = context.continuation?.continuation_pr ?? context.pullRequestNumber;
    try {
        const outcome = await autoAssignImplementationPullRequest({
            owner: context.repoOwner, repo: context.repoName, prNumber, taskId,
            opportunity: 'followup_done', headSha: commit.commitHash, linkedIssue: context.linkedIssue,
            octokit: context.octokit, redis: context.redis, logger,
        });
        await recordAutoAssignmentEvent({ stateManager, taskId, prNumber, outcome, logger });
    } catch (error) {
        logger.warn({ prNumber, error: (error as Error).message }, 'Pull request auto-assignment after follow-up failed');
    }
}
