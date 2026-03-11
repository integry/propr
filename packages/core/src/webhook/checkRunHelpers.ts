import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';

export interface MergePROptions {
    owner: string;
    repoName: string;
    prNumber: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
    commitMessage?: string;
}

export interface MergePRResult {
    success: boolean;
    error?: string;
    merged?: boolean;
    sha?: string;
}

/**
 * Attempts to merge a PR using the REST API.
 * This is used as a fallback when GitHub's native auto-merge isn't available
 * (e.g., when branch protection rules aren't configured).
 */
export async function mergePR(options: MergePROptions): Promise<MergePRResult> {
    const { owner, repoName, prNumber, mergeMethod = 'squash', commitTitle, commitMessage } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        logger.info({ owner, repoName, prNumber, mergeMethod, commitTitle }, 'Attempting to merge PR...');

        const response = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
            owner,
            repo: repoName,
            pull_number: prNumber,
            merge_method: mergeMethod,
            ...(commitTitle && { commit_title: commitTitle }),
            ...(commitMessage && { commit_message: commitMessage })
        });

        logger.info({
            owner,
            repoName,
            prNumber,
            sha: response.data.sha,
            merged: response.data.merged
        }, 'PR merged successfully');

        return {
            success: true,
            merged: response.data.merged,
            sha: response.data.sha
        };
    } catch (error) {
        const err = error as Error & { status?: number; response?: { data?: { message?: string } } };
        const errorMessage = err.response?.data?.message || err.message;

        logger.warn({
            owner,
            repoName,
            prNumber,
            error: errorMessage,
            status: err.status
        }, 'Failed to merge PR');

        return {
            success: false,
            error: errorMessage
        };
    }
}

/**
 * Deletes the branch associated with a PR after merge.
 */
export async function deleteBranch(
    owner: string,
    repoName: string,
    prNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        const octokit = await getAuthenticatedOctokit();

        // Get the PR to find the branch name
        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const branchName = prResponse.data.head.ref;
        const branchOwner = prResponse.data.head.repo?.owner?.login;

        // Only delete if the branch is in the same repo (not a fork)
        if (branchOwner !== owner) {
            log.debug({ owner, repoName, prNumber, branchOwner }, 'Branch is from a fork, not deleting');
            return;
        }

        await octokit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
            owner,
            repo: repoName,
            ref: `heads/${branchName}`
        });

        log.info({ owner, repoName, prNumber, branchName }, 'Deleted PR branch after merge');
    } catch (error) {
        // Non-fatal - branch might already be deleted or protected
        log.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to delete PR branch');
    }
}

interface FirstCommitInfo {
    title: string;
    message: string;
}

/**
 * Gets the first commit message of a PR branch.
 */
export async function getFirstCommitMessage(
    owner: string,
    repoName: string,
    prNumber: number
): Promise<FirstCommitInfo | null> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const commitsResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
            owner,
            repo: repoName,
            pull_number: prNumber,
            per_page: 100
        });

        const commits = commitsResponse.data;
        if (commits.length === 0) {
            return null;
        }

        const firstCommit = commits[0];
        const fullMessage = firstCommit.commit.message;

        const lines = fullMessage.split('\n');
        const title = lines[0];
        const message = lines.slice(1).join('\n').trim();

        return { title, message };
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to get first commit message');
        return null;
    }
}

/**
 * Gets the current HEAD SHA of a PR to verify checks are for the latest commit.
 */
export async function getCurrentPRHead(owner: string, repoName: string, prNumber: number): Promise<string | null> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        return prResponse.data.head.sha;
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to get current PR head');
        return null;
    }
}

/**
 * Checks if all check runs have passed for a PR.
 */
export async function areAllChecksPassing(owner: string, repoName: string, ref: string): Promise<boolean> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const checkRunsResponse = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
            owner,
            repo: repoName,
            ref
        });

        const checkRuns = checkRunsResponse.data.check_runs;

        const allCheckRunsPass = checkRuns.length > 0 && checkRuns.every(
            (run: { status: string; conclusion: string | null }) =>
                run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'skipped')
        );

        logger.debug({
            owner,
            repoName,
            ref,
            totalCheckRuns: checkRuns.length,
            allCheckRunsPass
        }, 'Checked PR status');

        return allCheckRunsPass;
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            ref,
            error: (error as Error).message
        }, 'Failed to check PR status');
        return false;
    }
}

export interface PRAutoMergeInfo {
    hasLabel: boolean;
    isDraft: boolean;
    baseBranch: string;
    headBranch: string;
}

/**
 * Checks if a PR has the auto-merge label, if it's a draft, and gets the base/head branches.
 */
export async function getPRAutoMergeInfo(owner: string, repoName: string, prNumber: number): Promise<PRAutoMergeInfo> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const labels = prResponse.data.labels as Array<{ name: string }>;
        const hasLabel = labels.some(label => label.name === 'auto-merge');
        const isDraft = prResponse.data.draft ?? false;
        const baseBranch = prResponse.data.base.ref;
        const headBranch = prResponse.data.head.ref;

        return { hasLabel, isDraft, baseBranch, headBranch };
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to check PR info');
        return { hasLabel: false, isDraft: false, baseBranch: '', headBranch: '' };
    }
}

/**
 * Checks if the linked issue (if any) has the auto-merge label.
 */
export async function linkedIssueHasAutoMergeLabel(owner: string, repoName: string, prNumber: number): Promise<boolean> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const prBody = prResponse.data.body || '';

        const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);
        if (!issueRefs) return false;

        for (const ref of issueRefs) {
            const match = ref.match(/#(\d+)/);
            if (!match) continue;

            const issueNumber = parseInt(match[1], 10);

            const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner,
                repo: repoName,
                issue_number: issueNumber
            });

            const labels = issueResponse.data.labels as Array<{ name: string } | string>;
            const hasLabel = labels.some(label =>
                (typeof label === 'string' ? label : label.name) === 'auto-merge'
            );

            if (hasLabel) {
                logger.debug({
                    owner,
                    repoName,
                    prNumber,
                    issueNumber
                }, 'Found auto-merge label on linked issue');
                return true;
            }
        }

        return false;
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to check linked issue labels');
        return false;
    }
}
