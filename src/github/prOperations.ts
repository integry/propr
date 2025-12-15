import { Octokit } from '@octokit/core';
import { getAuthenticatedOctokit, logger, ensureBranchAndPush, handleError, getModelShortName } from '@gitfix/core';
import { generatePRBody, generateClaudeLogsComment } from './prFormatters.js';

const DEFAULT_BASE_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';

export interface ClaudeResult {
    success?: boolean;
    executionTime?: number;
    finalResult?: {
        num_turns?: number;
        cost_usd?: number;
        subtype?: string | null;
    };
    sessionId?: string;
    conversationId?: string;
    summary?: string;
    conversationLog?: ConversationLogEntry[];
    modifiedFiles?: string[];
    rawOutput?: string;
    exitCode?: number | string;
    model?: string;
}

interface ConversationLogEntry {
    type: string;
    message?: {
        content?: string | ContentBlock[];
    };
}

interface ContentBlock {
    text?: string;
}

export interface PRInfo {
    number: number;
    url: string;
    title: string;
    state?: string;
}

interface PRResult {
    skipPR?: boolean;
    error?: string;
    success?: boolean;
    pr?: PRInfo;
}

interface RepoContext {
    owner: string;
    repoName: string;
    branchName: string;
}

interface BranchParams {
    owner: string;
    repoName: string;
    baseBranch: string;
    branchName: string;
}

interface PRParams {
    owner: string;
    repoName: string;
    prTitle: string;
    branchName: string;
    baseBranch: string;
    prBody: string;
}

export interface CreatePullRequestRobustParams {
    owner: string;
    repoName: string;
    branchName: string;
    baseBranch: string;
    issueNumber: number;
    prTitle: string;
    prBody: string;
    worktreePath: string;
    repoUrl: string;
    authToken: string;
    correlationId?: string;
}

export interface CreatePullRequestOptions {
    owner: string;
    repoName: string;
    branchName: string;
    baseBranch?: string;
    issueNumber: number;
    issueTitle: string;
    commitMessage: string;
    claudeResult: ClaudeResult;
    modelName?: string;
}

export interface AddClaudeLogsCommentOptions {
    owner: string;
    repoName: string;
    prNumber: number;
    claudeResult: ClaudeResult;
    issueNumber: number;
}

export interface UpdateIssueLabelsOptions {
    owner: string;
    repoName: string;
    issueNumber: number;
    labelsToRemove?: string[];
    labelsToAdd?: string[];
}

interface ExistingPRResult {
    success: boolean;
    pr: PRInfo;
}

interface PRCreateResponse {
    data: {
        number: number;
        html_url: string;
        title: string;
        state: string;
    };
    existingPR?: ExistingPRResult;
}

async function findExistingPRForBranch(octokit: InstanceType<typeof Octokit>, repoContext: RepoContext, errorMessage: string): Promise<ExistingPRResult | null> {
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

async function waitForBranchPropagation(octokit: InstanceType<typeof Octokit>, owner: string, repoName: string, branchName: string): Promise<void> {
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

async function compareBranches(octokit: InstanceType<typeof Octokit>, branchParams: BranchParams): Promise<{ skipPR: boolean }> {
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

interface ErrorLike {
    status?: number;
    message?: string;
}

function isHistorySyncError(error: ErrorLike): boolean {
    const status = error.status;
    const message = error.message || '';
    return (status === 422 || status === 400) &&
        (message.includes('no history in common') ||
         message.includes('does not have any commits') ||
         message.includes('No commits between') ||
         message.includes('Head sha can\'t be blank') ||
         message.includes('Base sha can\'t be blank'));
}

async function createPRWithRetry(octokit: InstanceType<typeof Octokit>, prParams: PRParams): Promise<PRCreateResponse> {
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

export async function createPullRequestRobust(params: CreatePullRequestRobustParams): Promise<PRResult> {
    const { owner, repoName, branchName, baseBranch, issueNumber, prTitle, prBody, worktreePath, repoUrl, authToken } = params;

    const octokit = await getAuthenticatedOctokit();

    try {
        logger.info({ owner, repoName, branchName, baseBranch, issueNumber, prTitle }, 'Creating pull request with robust git operations...');

        await ensureBranchAndPush(worktreePath, branchName, baseBranch, {
            repoUrl, authToken,
            tokenRefreshFn: async () => {
                const auth = await (octokit as unknown as { auth: (opts: { type: string }) => Promise<{ token: string }> }).auth({ type: "installation" });
                return auth.token;
            },
            correlationId: params.correlationId || 'unknown'
        });

        await waitForBranchPropagation(octokit, owner, repoName, branchName);

        const compareResult = await compareBranches(octokit, { owner, repoName, baseBranch, branchName });
        if (compareResult.skipPR) {
            return { success: false, error: 'No commits between base and head branch', skipPR: true };
        }

        const response = await createPRWithRetry(octokit, { owner, repoName, prTitle, branchName, baseBranch, prBody });
        if (response.existingPR) return response.existingPR;

        const prData = response.data;
        logger.info({ owner, repoName, issueNumber, prNumber: prData.number, prUrl: prData.html_url, branchName, baseBranch }, 'Pull request created successfully');

        return { success: true, pr: { number: prData.number, url: prData.html_url, title: prData.title, state: prData.state } };

    } catch (error) {
        logger.error({ owner, repoName, branchName, baseBranch, issueNumber, error: (error as Error).message }, 'Failed to create pull request');
        handleError(error, `Failed to create pull request for ${owner}/${repoName}#${issueNumber}`);
        throw error;
    }
}

export async function createPullRequest(options: CreatePullRequestOptions): Promise<PRInfo> {
    const {
        owner,
        repoName,
        branchName,
        baseBranch = DEFAULT_BASE_BRANCH,
        issueNumber,
        issueTitle,
        commitMessage,
        claudeResult,
        modelName
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        const modelShortName = getModelShortName(modelName);
        const prTitle = `${modelShortName} Fix for Issue #${issueNumber}: ${issueTitle}`;
        const prBody = generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult);

        logger.info({
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber,
            prTitle
        }, 'Creating pull request...');

        const response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner,
            repo: repoName,
            title: prTitle,
            head: branchName,
            base: baseBranch,
            body: prBody,
            draft: false
        });

        const prData = response.data;

        logger.info({
            owner,
            repoName,
            issueNumber,
            prNumber: prData.number,
            prUrl: prData.html_url,
            branchName
        }, 'Pull request created successfully');

        return {
            number: prData.number,
            url: prData.html_url,
            title: prData.title
        };

    } catch (error) {
        handleError(error, `Failed to create pull request for issue #${issueNumber}`);
        throw error;
    }
}

export async function addClaudeLogsComment(options: AddClaudeLogsCommentOptions): Promise<void> {
    const {
        owner,
        repoName,
        prNumber,
        claudeResult,
        issueNumber
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        const commentBody = generateClaudeLogsComment(claudeResult, issueNumber);

        logger.info({
            owner,
            repoName,
            prNumber,
            issueNumber,
            commentLength: commentBody.length
        }, 'Adding Claude logs comment to PR...');

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo: repoName,
            issue_number: prNumber,
            body: commentBody
        });

        logger.info({
            owner,
            repoName,
            prNumber,
            issueNumber
        }, 'Claude logs comment added successfully');

    } catch (error) {
        handleError(error, `Failed to add Claude logs comment to PR #${prNumber}`);
        throw error;
    }
}

export async function updateIssueLabels(options: UpdateIssueLabelsOptions): Promise<string[]> {
    const {
        owner,
        repoName,
        issueNumber,
        labelsToRemove = [],
        labelsToAdd = []
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner,
            repo: repoName,
            issue_number: issueNumber
        });

        const currentLabels = (issueResponse.data.labels as Array<{ name: string }>).map(label => label.name);

        const updatedLabels = [
            ...currentLabels.filter(label => !labelsToRemove.includes(label)),
            ...labelsToAdd.filter(label => !currentLabels.includes(label))
        ];

        logger.info({
            owner,
            repoName,
            issueNumber,
            currentLabels,
            labelsToRemove,
            labelsToAdd,
            updatedLabels
        }, 'Updating issue labels...');

        await octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo: repoName,
            issue_number: issueNumber,
            labels: updatedLabels
        });

        logger.info({
            owner,
            repoName,
            issueNumber,
            updatedLabels
        }, 'Issue labels updated successfully');

        return updatedLabels;

    } catch (error) {
        handleError(error, `Failed to update labels for issue #${issueNumber}`);
        throw error;
    }
}
