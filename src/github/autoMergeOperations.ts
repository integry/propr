import { getAuthenticatedOctokit, logger, handleError } from '@propr/core';

/**
 * Auto-merge method options supported by GitHub.
 */
export type AutoMergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

export interface EnableAutoMergeOptions {
    owner: string;
    repoName: string;
    prNumber: number;
    mergeMethod?: AutoMergeMethod;
    commitHeadline?: string;
    commitBody?: string;
}

export interface EnableAutoMergeResult {
    success: boolean;
    error?: string;
    autoMergeEnabled?: boolean;
}

export interface DisableAutoMergeOptions {
    owner: string;
    repoName: string;
    prNumber: number;
}

export interface DisableAutoMergeResult {
    success: boolean;
    error?: string;
}

interface AutoMergeGraphQLResponse {
    enablePullRequestAutoMerge: {
        pullRequest: {
            autoMergeRequest: {
                enabledAt: string;
                enabledBy: {
                    login: string;
                };
                mergeMethod: string;
            } | null;
        };
    };
}

interface DisableAutoMergeGraphQLResponse {
    disablePullRequestAutoMerge: {
        pullRequest: {
            autoMergeRequest: {
                enabledAt: string;
            } | null;
        };
    };
}

/**
 * Enables auto-merge for a pull request using the GitHub GraphQL API.
 *
 * Auto-merge will automatically merge the PR once all required status checks
 * and approvals are satisfied.
 *
 * @param options - Options for enabling auto-merge
 * @returns Result indicating success or failure
 */
export async function enableAutoMerge(options: EnableAutoMergeOptions): Promise<EnableAutoMergeResult> {
    const {
        owner,
        repoName,
        prNumber,
        mergeMethod = 'SQUASH',
        commitHeadline,
        commitBody
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        logger.info({
            owner,
            repoName,
            prNumber,
            mergeMethod
        }, 'Enabling auto-merge for PR...');

        // First, get the PR's node ID using REST API
        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const pullRequestId = prResponse.data.node_id;

        // Build the GraphQL mutation
        const mutation = `
            mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $commitHeadline: String, $commitBody: String) {
                enablePullRequestAutoMerge(input: {
                    pullRequestId: $pullRequestId
                    mergeMethod: $mergeMethod
                    commitHeadline: $commitHeadline
                    commitBody: $commitBody
                }) {
                    pullRequest {
                        autoMergeRequest {
                            enabledAt
                            enabledBy {
                                login
                            }
                            mergeMethod
                        }
                    }
                }
            }
        `;

        // Execute the GraphQL mutation
        const result = await octokit.graphql<AutoMergeGraphQLResponse>(mutation, {
            pullRequestId,
            mergeMethod,
            commitHeadline: commitHeadline || null,
            commitBody: commitBody || null
        });

        const autoMergeRequest = result.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest;

        if (autoMergeRequest) {
            logger.info({
                owner,
                repoName,
                prNumber,
                enabledAt: autoMergeRequest.enabledAt,
                enabledBy: autoMergeRequest.enabledBy?.login,
                mergeMethod: autoMergeRequest.mergeMethod
            }, 'Auto-merge enabled successfully');

            return {
                success: true,
                autoMergeEnabled: true
            };
        }

        return {
            success: true,
            autoMergeEnabled: false
        };

    } catch (error) {
        const err = error as Error & { errors?: Array<{ message: string }> };

        // Handle specific GraphQL errors
        if (err.errors && err.errors.length > 0) {
            const errorMessages = err.errors.map(e => e.message).join(', ');
            logger.warn({
                owner,
                repoName,
                prNumber,
                errors: errorMessages
            }, 'Failed to enable auto-merge (GraphQL errors)');

            return {
                success: false,
                error: errorMessages
            };
        }

        logger.error({
            owner,
            repoName,
            prNumber,
            error: err.message
        }, 'Failed to enable auto-merge');

        handleError(error, `Failed to enable auto-merge for PR #${prNumber}`);

        return {
            success: false,
            error: err.message
        };
    }
}

/**
 * Disables auto-merge for a pull request using the GitHub GraphQL API.
 *
 * @param options - Options for disabling auto-merge
 * @returns Result indicating success or failure
 */
export async function disableAutoMerge(options: DisableAutoMergeOptions): Promise<DisableAutoMergeResult> {
    const { owner, repoName, prNumber } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        logger.info({
            owner,
            repoName,
            prNumber
        }, 'Disabling auto-merge for PR...');

        // First, get the PR's node ID using REST API
        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const pullRequestId = prResponse.data.node_id;

        // Build the GraphQL mutation
        const mutation = `
            mutation DisableAutoMerge($pullRequestId: ID!) {
                disablePullRequestAutoMerge(input: {
                    pullRequestId: $pullRequestId
                }) {
                    pullRequest {
                        autoMergeRequest {
                            enabledAt
                        }
                    }
                }
            }
        `;

        await octokit.graphql<DisableAutoMergeGraphQLResponse>(mutation, {
            pullRequestId
        });

        logger.info({
            owner,
            repoName,
            prNumber
        }, 'Auto-merge disabled successfully');

        return { success: true };

    } catch (error) {
        const err = error as Error & { errors?: Array<{ message: string }> };

        if (err.errors && err.errors.length > 0) {
            const errorMessages = err.errors.map(e => e.message).join(', ');
            logger.warn({
                owner,
                repoName,
                prNumber,
                errors: errorMessages
            }, 'Failed to disable auto-merge (GraphQL errors)');

            return {
                success: false,
                error: errorMessages
            };
        }

        logger.error({
            owner,
            repoName,
            prNumber,
            error: err.message
        }, 'Failed to disable auto-merge');

        handleError(error, `Failed to disable auto-merge for PR #${prNumber}`);

        return {
            success: false,
            error: err.message
        };
    }
}
