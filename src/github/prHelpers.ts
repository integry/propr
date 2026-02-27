import { Octokit } from '@octokit/core';
import { logger } from '@propr/core';

export interface PRInfo {
    number: number;
    url: string;
    title: string;
    state?: string;
}

interface RepoContext {
    owner: string;
    repoName: string;
    branchName: string;
}

export interface BranchParams {
    owner: string;
    repoName: string;
    baseBranch: string;
    branchName: string;
}

export interface PRParams {
    owner: string;
    repoName: string;
    prTitle: string;
    branchName: string;
    baseBranch: string;
    prBody: string;
}

interface ExistingPRResult {
    success: boolean;
    pr: PRInfo;
}

export interface PRCreateResponse {
    data: {
        number: number;
        html_url: string;
        title: string;
        state: string;
    };
    existingPR?: ExistingPRResult;
}

interface ErrorLike {
    status?: number;
    message?: string;
}

export async function findExistingPRForBranch(octokit: InstanceType<typeof Octokit>, repoContext: RepoContext, errorMessage: string): Promise<ExistingPRResult | null> {
    const { owner, repoName, branchName } = repoContext;
    logger.info({ owner, repoName, branchName, error: errorMessage }, 'PR already exists for this branch, attempting to find existing PR');

    try {
        const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo: repoName,
            head: `${owner}:${branchName}`,
            state: 'open'
        });

        if (existingPRs.data.length > 0) {
            const existingPR = existingPRs.data[0];
            logger.info({ owner, repoName, branchName, prNumber: existingPR.number, prUrl: existingPR.html_url }, 'Found existing PR for branch');

            return {
                success: true,
                pr: {
                    number: existingPR.number,
                    url: existingPR.html_url,
                    title: existingPR.title,
                    state: existingPR.state
                }
            };
        }
    } catch (findError) {
        logger.warn({ error: (findError as Error).message }, 'Failed to find existing PR');
    }
    return null;
}

export async function waitForBranchPropagation(octokit: InstanceType<typeof Octokit>, owner: string, repoName: string, branchName: string): Promise<void> {
    logger.debug({ branchName }, 'Waiting for GitHub to propagate branch data...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
                owner,
                repo: repoName,
                branch: branchName
            });
            logger.debug({ branchName, attempt }, 'Confirmed branch exists on remote');
            return;
        } catch (branchCheckError) {
            if (attempt === maxRetries) {
                throw new Error(`Branch '${branchName}' does not exist on remote after ${maxRetries} attempts: ${(branchCheckError as Error).message}`);
            }

            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
            logger.debug({ branchName, attempt, delay, error: (branchCheckError as Error).message }, 'Branch not found, retrying...');
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

export async function compareBranches(octokit: InstanceType<typeof Octokit>, branchParams: BranchParams): Promise<{ skipPR: boolean }> {
    const { owner, repoName, baseBranch, branchName } = branchParams;
    try {
        const compareResult = await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
            owner,
            repo: repoName,
            base: baseBranch,
            head: branchName
        });

        if (compareResult.data.ahead_by === 0) {
            logger.warn({ owner, repoName, branchName, baseBranch, aheadBy: compareResult.data.ahead_by }, 'No commits found between base and head branch - skipping PR creation');
            return { skipPR: true };
        }

        logger.debug({ branchName, baseBranch, aheadBy: compareResult.data.ahead_by, behindBy: compareResult.data.behind_by }, 'Confirmed commits exist between branches');
        return { skipPR: false };
    } catch (compareError) {
        logger.warn({ branchName, baseBranch, error: (compareError as Error).message }, 'Could not compare branches, proceeding with PR creation anyway');
        return { skipPR: false };
    }
}

export function isHistorySyncError(error: ErrorLike): boolean {
    const status = error.status;
    const message = error.message || '';
    return (status === 422 || status === 400) &&
        (message.includes('no history in common') ||
         message.includes('does not have any commits') ||
         message.includes('No commits between') ||
         message.includes('Head sha can\'t be blank') ||
         message.includes('Base sha can\'t be blank'));
}

export async function createPRWithRetry(octokit: InstanceType<typeof Octokit>, prParams: PRParams): Promise<PRCreateResponse> {
    const { owner, repoName, prTitle, branchName, baseBranch, prBody } = prParams;

    try {
        return await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner, repo: repoName, title: prTitle, head: branchName, base: baseBranch, body: prBody, draft: false
        });
    } catch (prCreateError) {
        const err = prCreateError as ErrorLike;
        if (err.status === 422 && err.message?.includes('A pull request already exists')) {
            const existingResult = await findExistingPRForBranch(octokit, { owner, repoName, branchName }, err.message);
            if (existingResult) return { existingPR: existingResult } as PRCreateResponse;
        }

        if (isHistorySyncError(err)) {
            logger.warn({ owner, repoName, branchName, baseBranch, error: err.message }, 'Branch has no history in common with base branch, waiting for GitHub sync...');
            await new Promise(resolve => setTimeout(resolve, 10000));

            try {
                const retryResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
                    owner, repo: repoName, title: prTitle, head: branchName, base: baseBranch, body: prBody, draft: false
                });
                logger.info({ owner, repoName, branchName, baseBranch }, 'PR creation succeeded after retry for history sync issue');
                return retryResponse;
            } catch (retryError) {
                logger.error({ owner, repoName, branchName, baseBranch, originalError: err.message, retryError: (retryError as Error).message }, 'PR creation failed even after retry for history sync issue');
                throw retryError;
            }
        }
        throw prCreateError;
    }
}
