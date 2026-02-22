import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { findPlanIssueByRepoAndPR, updatePlanIssueByPR } from '../config/planIssueManager.js';
import { isEpicBranch } from '../services/taskExecutionService.js';
import type { CheckRunEvent } from '@octokit/webhooks-types';

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
async function deleteBranch(
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
 * This is useful for squash merges where we want to use the original
 * descriptive commit message instead of the last commit (which is often just a lint fix).
 */
async function getFirstCommitMessage(
    owner: string,
    repoName: string,
    prNumber: number
): Promise<FirstCommitInfo | null> {
    try {
        const octokit = await getAuthenticatedOctokit();

        // Get all commits in the PR, sorted by date (oldest first)
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

        // The first commit in the array is the oldest (first) commit
        const firstCommit = commits[0];
        const fullMessage = firstCommit.commit.message;

        // Split into title (first line) and body (rest)
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
async function getCurrentPRHead(owner: string, repoName: string, prNumber: number): Promise<string | null> {
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
 * Only checks GitHub Actions check runs (not legacy commit statuses).
 */
async function areAllChecksPassing(owner: string, repoName: string, ref: string): Promise<boolean> {
    try {
        const octokit = await getAuthenticatedOctokit();

        // Check runs are used by GitHub Actions and modern CI systems
        const checkRunsResponse = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
            owner,
            repo: repoName,
            ref
        });

        const checkRuns = checkRunsResponse.data.check_runs;

        // All check runs must be completed and successful
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

interface PRAutoMergeInfo {
    hasLabel: boolean;
    isDraft: boolean;
    baseBranch: string;
    headBranch: string;
}

/**
 * Checks if a PR has the auto-merge label, if it's a draft, and gets the base/head branches.
 */
async function getPRAutoMergeInfo(owner: string, repoName: string, prNumber: number): Promise<PRAutoMergeInfo> {
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
async function linkedIssueHasAutoMergeLabel(owner: string, repoName: string, prNumber: number): Promise<boolean> {
    try {
        const octokit = await getAuthenticatedOctokit();

        // Get PR details to find linked issues
        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const prBody = prResponse.data.body || '';

        // Find issue references in PR body (fixes #123, closes #123, etc.)
        const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);
        if (!issueRefs) return false;

        for (const ref of issueRefs) {
            const match = ref.match(/#(\d+)/);
            if (match) {
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

/**
 * Handles check_run webhook events.
 * When a check run completes successfully, checks if the PR should be auto-merged.
 */
export async function handleCheckRunEvent(
    payload: CheckRunEvent,
    correlationId: string
): Promise<void> {
    const log = logger.withCorrelation(correlationId);

    // Only process completed check runs
    if (payload.action !== 'completed') {
        return;
    }

    // Only process successful check runs
    const conclusion = payload.check_run.conclusion;
    if (conclusion !== 'success' && conclusion !== 'skipped') {
        return;
    }

    // Get associated PRs
    const pullRequests = payload.check_run.pull_requests;
    if (!pullRequests || pullRequests.length === 0) {
        return;
    }

    const [owner, repoName] = payload.repository.full_name.split('/');

    for (const pr of pullRequests) {
        const prNumber = pr.number;
        const headSha = payload.check_run.head_sha;

        log.debug({
            owner,
            repoName,
            prNumber,
            checkRunName: payload.check_run.name,
            conclusion
        }, 'Processing check run completion for PR');

        try {
            // Check if PR is a draft or has auto-merge label
            const prInfo = await getPRAutoMergeInfo(owner, repoName, prNumber);

            if (prInfo.isDraft) {
                log.debug({ owner, repoName, prNumber }, 'PR is a draft, skipping auto-merge');
                continue;
            }

            // For Epic PRs, only auto-merge if the PR itself has the label (not inherited from linked issues)
            if (isEpicBranch(prInfo.headBranch)) {
                if (!prInfo.hasLabel) {
                    log.debug({ owner, repoName, prNumber, headBranch: prInfo.headBranch }, 'Epic PR does not have auto-merge label, skipping');
                    continue;
                }
            } else {
                // For regular PRs, check both PR label and linked issue labels
                const issueHasLabel = await linkedIssueHasAutoMergeLabel(owner, repoName, prNumber);
                if (!prInfo.hasLabel && !issueHasLabel) {
                    log.debug({ owner, repoName, prNumber }, 'PR does not have auto-merge label, skipping');
                    continue;
                }
            }

            // Verify the check_run SHA matches the current PR head
            // This prevents merging unchecked commits pushed after checks started
            const currentPrHead = await getCurrentPRHead(owner, repoName, prNumber);
            if (currentPrHead !== headSha) {
                log.debug({
                    owner,
                    repoName,
                    prNumber,
                    checkRunSha: headSha,
                    currentPrHead
                }, 'Check run SHA does not match current PR head, skipping (newer commits exist)');
                continue;
            }

            // Check if all checks are passing
            const allChecksPassing = await areAllChecksPassing(owner, repoName, headSha);
            if (!allChecksPassing) {
                log.debug({ owner, repoName, prNumber }, 'Not all checks are passing yet, skipping merge');
                continue;
            }

            log.info({
                owner,
                repoName,
                prNumber,
                headSha
            }, 'All checks passing for auto-merge PR, attempting to merge');

            // For PRs targeting an epic branch, use the first commit message
            // (the initial feature implementation) instead of the last commit
            // (which is often just a lint fix)
            let commitTitle: string | undefined;
            let commitMessage: string | undefined;

            if (isEpicBranch(prInfo.baseBranch)) {
                const firstCommit = await getFirstCommitMessage(owner, repoName, prNumber);
                if (firstCommit) {
                    commitTitle = firstCommit.title;
                    commitMessage = firstCommit.message;
                    log.debug({
                        owner,
                        repoName,
                        prNumber,
                        commitTitle
                    }, 'Using first commit message for epic branch merge');
                }
            }

            // Attempt to merge
            const mergeResult = await mergePR({
                owner,
                repoName,
                prNumber,
                mergeMethod: 'squash',
                commitTitle,
                commitMessage
            });

            if (mergeResult.success && mergeResult.merged) {
                log.info({
                    owner,
                    repoName,
                    prNumber,
                    sha: mergeResult.sha
                }, 'PR auto-merged successfully');

                // Delete the branch after successful merge
                await deleteBranch(owner, repoName, prNumber, log);

                // Update plan issue status if linked
                const repository = `${owner}/${repoName}`;
                const planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);
                if (planIssue) {
                    await updatePlanIssueByPR(repository, prNumber, { status: 'merged' });
                    log.info({ repository, prNumber }, 'Updated plan issue status to merged');
                }
            } else {
                log.warn({
                    owner,
                    repoName,
                    prNumber,
                    error: mergeResult.error
                }, 'Failed to auto-merge PR');
            }
        } catch (error) {
            log.error({
                owner,
                repoName,
                prNumber,
                error: (error as Error).message
            }, 'Error processing auto-merge for PR');
        }
    }
}
