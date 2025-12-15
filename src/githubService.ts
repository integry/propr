import { getAuthenticatedOctokit, handleError } from '@gitfix/core';
import { logger } from '@gitfix/core';
import { generatePRBody } from './github/prFormatters.js';
import {
    createPullRequestRobust as createPullRequestRobustOps,
    createPullRequest as createPullRequestOps,
    addClaudeLogsComment as addClaudeLogsCommentOps,
    updateIssueLabels as updateIssueLabelsOps,
    ClaudeResult,
    PRInfo,
    CreatePullRequestOptions,
    CreatePullRequestRobustParams,
    AddClaudeLogsCommentOptions,
    UpdateIssueLabelsOptions
} from './github/prOperations.js';

export const createPullRequestRobust = createPullRequestRobustOps;
export const createPullRequest = createPullRequestOps;
export const addClaudeLogsComment = addClaudeLogsCommentOps;
export const updateIssueLabels = updateIssueLabelsOps;

export type { ClaudeResult, PRInfo, CreatePullRequestOptions, CreatePullRequestRobustParams, AddClaudeLogsCommentOptions, UpdateIssueLabelsOptions };

// Model ID to short name mapping for PR titles
// This mirrors the UI constants in AgentsListSection.tsx
const MODEL_SHORT_NAMES: Record<string, string> = {
    // Claude models
    'claude-opus-4-5-20251101': 'Claude Opus',
    'claude-sonnet-4-5-20250929': 'Claude Sonnet',
    'claude-haiku-4-5-20251001': 'Claude Haiku',
    // OpenAI/Codex models
    'gpt-5': 'GPT-5',
    'gpt-5-mini': 'GPT-5 Mini',
    'gpt-5-codex': 'Codex',
    'o3': 'o3',
    'o4-mini': 'o4-mini',
    // Gemini models
    'gemini-3-pro-preview': 'Gemini 3 Preview',
    'gemini-2.5-pro': 'Gemini Pro',
    'gemini-2.5-flash': 'Gemini Flash',
    'gemini-2.5-flash-lite': 'Flash Lite',
};

function getModelShortName(modelId: string | undefined): string {
    if (!modelId) return 'AI';
    return MODEL_SHORT_NAMES[modelId] || 'AI';
}

interface PRContext {
    owner: string;
    repoName: string;
    branchName: string;
    baseBranch?: string;
    issueNumber: number;
    issueTitle: string;
    commitMessage: string;
    worktreePath?: string;
    repoUrl?: string;
    authToken?: string;
    modelName?: string;
}

interface PRResult {
    skipPR?: boolean;
    error?: string;
    pr?: PRInfo;
    success?: boolean;
}

interface CompletePostProcessingOptions {
    owner: string;
    repoName: string;
    branchName: string;
    baseBranch?: string;
    issueNumber: number;
    issueTitle: string;
    commitMessage: string;
    claudeResult: ClaudeResult;
    processingTags?: string[];
    completionTags?: string[];
    worktreePath?: string;
    repoUrl?: string;
    authToken?: string;
}

interface PostProcessingResult {
    pr: PRInfo | null;
    updatedLabels: string[];
}

function handlePrResult(prResult: PRResult, logContext: Record<string, unknown>): PRInfo | null {
    if (prResult.skipPR) {
        logger.info({ ...logContext, reason: prResult.error }, 'PR creation skipped - no commits found between branches');
        return null;
    }
    return prResult.pr ?? null;
}

async function createNewPRForIssue(prContext: PRContext, claudeResult: ClaudeResult): Promise<PRInfo | null> {
    const { owner, repoName, branchName, baseBranch, issueNumber, issueTitle, commitMessage, worktreePath, repoUrl, authToken, modelName } = prContext;
    const hasRobustParams = worktreePath && baseBranch && repoUrl && authToken;
    const modelShortName = getModelShortName(modelName);

    if (hasRobustParams) {
        const prResult = await createPullRequestRobust({
            owner, repoName, branchName, baseBranch, issueNumber,
            prTitle: `${modelShortName} Fix for Issue #${issueNumber}: ${issueTitle}`,
            prBody: generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult),
            worktreePath, repoUrl, authToken
        });
        return handlePrResult(prResult, { owner, repoName, branchName, issueNumber });
    }
    return createPullRequest({ owner, repoName, branchName, issueNumber, issueTitle, commitMessage, claudeResult, modelName });
}

export async function completePostProcessing(options: CompletePostProcessingOptions): Promise<PostProcessingResult> {
    const {
        owner,
        repoName,
        branchName,
        baseBranch,
        issueNumber,
        issueTitle,
        commitMessage,
        claudeResult,
        processingTags = ['AI-processing'],
        completionTags = ['AI-done'],
        worktreePath,
        repoUrl,
        authToken
    } = options;

    let prInfo: PRInfo | null = null;
    let updatedLabels: string[] = [];

    try {
        logger.info({
            owner,
            repoName,
            issueNumber,
            branchName
        }, 'Starting post-processing workflow...');

        logger.info({
            owner,
            repoName,
            branchName
        }, 'Checking if PR already exists for branch...');

        const prContext: PRContext = { owner, repoName, branchName, baseBranch, issueNumber, issueTitle, commitMessage, worktreePath, repoUrl, authToken };
        try {
            const octokit = await getAuthenticatedOctokit();
            const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                owner,
                repo: repoName,
                head: `${owner}:${branchName}`,
                state: 'open'
            });

            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                logger.info({ owner, repoName, branchName, prNumber: existingPR.number, prUrl: existingPR.html_url }, 'Found existing PR created by Claude, using it instead of creating new one');
                prInfo = { number: existingPR.number, url: existingPR.html_url, title: existingPR.title, state: existingPR.state };
            } else {
                prInfo = await createNewPRForIssue(prContext, claudeResult);
            }
        } catch (checkError) {
            logger.warn({ error: (checkError as Error).message }, 'Failed to check for existing PR, proceeding with creation');
            prInfo = await createNewPRForIssue(prContext, claudeResult);
        }

        if (prInfo) {
            await addClaudeLogsComment({
                owner,
                repoName,
                prNumber: prInfo.number,
                claudeResult,
                issueNumber
            });
        }

        updatedLabels = await updateIssueLabels({
            owner,
            repoName,
            issueNumber,
            labelsToRemove: processingTags,
            labelsToAdd: completionTags
        });

        logger.info({
            owner,
            repoName,
            issueNumber,
            prNumber: prInfo?.number,
            prUrl: prInfo?.url
        }, 'Post-processing workflow completed successfully');

        return {
            pr: prInfo,
            updatedLabels
        };

    } catch (error) {
        try {
            await updateIssueLabels({
                owner,
                repoName,
                issueNumber,
                labelsToRemove: processingTags,
                labelsToAdd: ['AI-failed-post-processing']
            });
        } catch (labelError) {
            logger.warn({
                issueNumber,
                error: (labelError as Error).message
            }, 'Failed to update labels after post-processing failure');
        }

        handleError(error, `Post-processing failed for issue #${issueNumber}`);
        throw error;
    }
}
