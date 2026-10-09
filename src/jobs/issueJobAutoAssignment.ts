import { autoAssignImplementationPullRequest, recordAutoAssignmentEvent } from '../github/prAutoAssignment.js';
import { redisClient } from './issueJob/config.js';
import type { PostProcessingResult } from './issueJobHelpers.js';
import type { PostProcessOptions } from './issueJobPostProcessing.js';

/**
 * Assigns an implementation's new pull request per the repository's
 * auto-assignment policy once it carries the done label, and records the
 * decision on the task timeline. Never fails post-processing.
 */
export async function autoAssignCompletedPullRequest(options: PostProcessOptions, result: PostProcessingResult | null): Promise<void> {
    const prNumber = result?.pr?.number;
    if (!prNumber) return;
    const { octokit, issueRef, currentIssueData, correlatedLogger, taskId, stateManager } = options;
    try {
        const outcome = await autoAssignImplementationPullRequest({
            owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, prNumber, taskId,
            issueAuthor: currentIssueData.data.user?.login ?? null,
            octokit, redis: redisClient, logger: correlatedLogger,
        });
        if (taskId && stateManager) {
            await recordAutoAssignmentEvent({ stateManager, taskId, prNumber, outcome, logger: correlatedLogger });
        }
    } catch (error) {
        correlatedLogger.warn({ prNumber, error: (error as Error).message }, 'Pull request auto-assignment failed');
    }
}
