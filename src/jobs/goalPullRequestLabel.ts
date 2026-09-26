import {
    getAuthenticatedOctokit,
    logger,
    retryConfigs,
    withRetry,
} from '@propr/core';
import { getPrLabel } from './prLabel.js';

interface GoalPullRequestLabelDependencies {
    resolveLabel(): Promise<string>;
    getOctokit(): Promise<Awaited<ReturnType<typeof getAuthenticatedOctokit>>>;
    retry<T>(operation: () => Promise<T>, operationName: string): Promise<T>;
}

const defaultDependencies: GoalPullRequestLabelDependencies = {
    resolveLabel: getPrLabel,
    getOctokit: getAuthenticatedOctokit,
    retry: async (operation, operationName) => await withRetry(
        operation,
        retryConfigs.githubApi,
        operationName,
    ),
};

/**
 * Enable normal PR follow-ups only after a goal has completed successfully.
 * Label failures match regular task PR creation: log after retries and preserve
 * the otherwise successful result.
 */
export async function labelCompletedGoalPullRequest(
    repository: string,
    pullRequestNumber: number,
    dependencies: GoalPullRequestLabelDependencies = defaultDependencies,
): Promise<void> {
    const [owner, repo] = repository.split('/');
    let label: string | undefined;
    try {
        const resolvedLabel = await dependencies.resolveLabel();
        label = resolvedLabel;
        const octokit = await dependencies.getOctokit();
        await dependencies.retry(
            () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner,
                repo,
                issue_number: pullRequestNumber,
                labels: [resolvedLabel],
            }),
            `add_goal_pr_label_${pullRequestNumber}`,
        );
        logger.info({ repository, prNumber: pullRequestNumber, label }, 'Added PR label to completed goal PR');
    } catch (error) {
        logger.warn({
            repository,
            prNumber: pullRequestNumber,
            label,
            error: (error as Error).message,
        }, 'Failed to add PR label to completed goal PR after retries');
    }
}
