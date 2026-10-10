import type { Logger } from 'pino';
import { db, type IssueJobData, type WorkerStateManager } from '@propr/core';
import { autoAssignImplementationPullRequest, recordAutoAssignmentEvent } from '../github/prAutoAssignment.js';
import { redisClient } from './issueJob/config.js';

export interface CompletedPullRequestAssignmentContext {
    octokit: { request: <T = unknown>(route: string, parameters: Record<string, unknown>) => Promise<T> };
    issueRef: IssueJobData;
    correlatedLogger: Logger;
    taskId?: string;
    stateManager?: WorkerStateManager;
    /** The source issue as the caller already read it, for its author. */
    currentIssueData?: { data: { user?: { login?: string } | null } };
}

/**
 * Points the task at its pull request before the pull request is assigned.
 * Task completion records it too, but only later; until then a detail-page
 * read would resolve the source issue and store its assignees over the pull
 * request's. Fails soft: completion records it again.
 */
async function recordTaskPullRequest(taskId: string, prNumber: number, correlatedLogger: Logger): Promise<void> {
    try {
        await db('tasks').where({ task_id: taskId }).update({ pr_number: prNumber });
    } catch (error) {
        correlatedLogger.warn({ taskId, prNumber, error: (error as Error).message }, 'Failed to record the task\'s pull request before auto-assignment');
    }
}

/**
 * Assigns an implementation's pull request per the repository's
 * auto-assignment policy once it carries the done label, and records the
 * decision on the task timeline. Called wherever publication succeeds:
 * post-processing, and the final validation that finds or recreates a pull
 * request post-processing missed. Never fails the caller.
 */
export async function autoAssignCompletedPullRequest(context: CompletedPullRequestAssignmentContext, published: { pr?: { number?: number } | null } | null): Promise<void> {
    const prNumber = published?.pr?.number;
    if (!prNumber) return;
    const { octokit, issueRef, correlatedLogger, taskId, stateManager } = context;
    if (taskId) await recordTaskPullRequest(taskId, prNumber, correlatedLogger);
    try {
        const outcome = await autoAssignImplementationPullRequest({
            owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, prNumber, taskId,
            issueAuthor: context.currentIssueData?.data.user?.login ?? null,
            octokit, redis: redisClient, logger: correlatedLogger,
        });
        if (taskId && stateManager) {
            await recordAutoAssignmentEvent({ stateManager, taskId, prNumber, outcome, logger: correlatedLogger });
        }
    } catch (error) {
        correlatedLogger.warn({ prNumber, error: (error as Error).message }, 'Pull request auto-assignment failed');
    }
}
