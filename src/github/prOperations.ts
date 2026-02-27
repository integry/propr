import { getAuthenticatedOctokit, logger, ensureBranchAndPush, handleError, getModelShortName } from '@propr/core';
import { generatePRBody, generateClaudeLogsComment } from './prFormatters.js';
import { waitForBranchPropagation, compareBranches, createPRWithRetry, type PRInfo } from './prHelpers.js';

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
    tokenUsage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
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

export type { PRInfo };

interface PRResult {
    skipPR?: boolean;
    error?: string;
    success?: boolean;
    pr?: PRInfo;
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
        // Format: [412 by Claude Opus] Title
        const prTitle = `[${issueNumber} by ${modelShortName}] ${issueTitle}`;
        const prBody = await generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult);

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

        const commentBody = await generateClaudeLogsComment(claudeResult, issueNumber);

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

// Re-export auto-merge functions from separate module
export {
    enableAutoMerge,
    disableAutoMerge,
    type AutoMergeMethod,
    type EnableAutoMergeOptions,
    type EnableAutoMergeResult,
    type DisableAutoMergeOptions,
    type DisableAutoMergeResult
} from './autoMergeOperations.js';
