import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { isEpicBranch } from '../services/taskExecutionService.js';
import type { PullRequestEvent } from '@octokit/webhooks-types';

/**
 * Ensures Epic PR exists when a child PR is merged to an epic branch.
 * When the epic branch was first created, there were no commits so the PR couldn't be created.
 * Now that a child PR has merged, we can create the Epic PR.
 */
export async function handleEpicPRCreationOnMerge(
    payload: PullRequestEvent,
    _correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    // Only process closed PRs that were merged
    if (payload.action !== 'closed' || !payload.pull_request.merged) {
        return;
    }

    const baseBranch = payload.pull_request.base.ref;

    // Check if the base branch is an Epic branch (child PR merged to epic branch)
    if (!isEpicBranch(baseBranch)) {
        return;
    }

    const [owner, repo] = payload.repository.full_name.split('/');

    correlatedLogger.info({
        prNumber: payload.pull_request.number,
        baseBranch,
        owner,
        repo
    }, 'Child PR merged to epic branch, ensuring Epic PR exists');

    try {
        const octokit = await getAuthenticatedOctokit();

        // Check if Epic PR already exists
        const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            head: `${owner}:${baseBranch}`,
            state: 'open'
        });

        if (existingPRs.data.length > 0) {
            correlatedLogger.debug({
                prNumber: existingPRs.data[0].number,
                baseBranch
            }, 'Epic PR already exists');
            return;
        }

        // Get the default branch to use as base
        const repoResponse = await octokit.request('GET /repos/{owner}/{repo}', {
            owner,
            repo
        });
        const defaultBranch = repoResponse.data.default_branch;

        // Create the Epic PR
        const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            title: `[Epic] ${baseBranch}`,
            head: baseBranch,
            base: defaultBranch,
            body: `## Epic PR\n\nThis PR aggregates all changes from child PRs merged to the \`${baseBranch}\` branch.\n\n---\n*Created automatically by GitFix*`,
            draft: true
        });

        correlatedLogger.info({
            prNumber: prResponse.data.number,
            prUrl: prResponse.data.html_url,
            baseBranch
        }, 'Epic PR created after child PR merge');

    } catch (error) {
        const err = error as Error & { status?: number };
        correlatedLogger.warn({
            error: err.message,
            baseBranch,
            owner,
            repo
        }, 'Failed to create Epic PR after child merge');
    }
}

/**
 * Handles Epic PR label cleanup when an Epic PR is merged.
 * When a PR with an Epic branch name pattern is closed and merged,
 * this function automatically deletes the corresponding `base-{branchName}` label
 * from the repository.
 */
export async function handleEpicPRLabelCleanup(
    payload: PullRequestEvent,
    _correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    // Only process closed PRs that were merged
    if (payload.action !== 'closed' || !payload.pull_request.merged) {
        return;
    }

    const branchName = payload.pull_request.head.ref;

    // Check if this is an Epic branch
    if (!isEpicBranch(branchName)) {
        return;
    }

    const [owner, repo] = payload.repository.full_name.split('/');
    const labelName = `base-${branchName}`;

    correlatedLogger.info({
        prNumber: payload.pull_request.number,
        branchName,
        labelName,
        owner,
        repo
    }, 'Epic PR merged, cleaning up base label');

    try {
        const octokit = await getAuthenticatedOctokit();

        // Delete the label from the repository
        await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
            owner,
            repo,
            name: labelName
        });

        correlatedLogger.info({
            labelName,
            owner,
            repo
        }, 'Epic label deleted successfully');
    } catch (error) {
        const err = error as Error & { status?: number };
        if (err.status === 404) {
            correlatedLogger.debug({
                labelName,
                owner,
                repo
            }, 'Epic label not found, may have already been deleted');
        } else {
            correlatedLogger.warn({
                error: err.message,
                labelName,
                owner,
                repo
            }, 'Failed to delete Epic label');
        }
    }
}
