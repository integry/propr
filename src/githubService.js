import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger from './utils/logger.js';
import { handleError } from './utils/errorHandler.js';
import { generatePRBody } from './github/prFormatters.js';
import {
    createPullRequestRobust as createPullRequestRobustOps,
    createPullRequest as createPullRequestOps,
    addClaudeLogsComment as addClaudeLogsCommentOps,
    updateIssueLabels as updateIssueLabelsOps
} from './github/prOperations.js';

export const createPullRequestRobust = createPullRequestRobustOps;
export const createPullRequest = createPullRequestOps;
export const addClaudeLogsComment = addClaudeLogsCommentOps;
export const updateIssueLabels = updateIssueLabelsOps;

function handlePrResult(prResult, logContext) {
    if (prResult.skipPR) {
        logger.info({ ...logContext, reason: prResult.error }, 'PR creation skipped - no commits found between branches');
        return null;
    }
    return prResult.pr;
}

async function createNewPRForIssue(prContext, claudeResult) {
    const { owner, repoName, branchName, baseBranch, issueNumber, issueTitle, commitMessage, worktreePath, repoUrl, authToken } = prContext;
    const hasRobustParams = worktreePath && baseBranch && repoUrl && authToken;

    if (hasRobustParams) {
        const prResult = await createPullRequestRobust({
            owner, repoName, branchName, baseBranch, issueNumber,
            prTitle: `AI Fix for Issue #${issueNumber}: ${issueTitle}`,
            prBody: generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult),
            worktreePath, repoUrl, authToken
        });
        return handlePrResult(prResult, { owner, repoName, branchName, issueNumber });
    }
    return createPullRequest({ owner, repoName, branchName, issueNumber, issueTitle, commitMessage, claudeResult });
}

export async function completePostProcessing(options) {
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

    let prInfo = null;
    let updatedLabels = [];

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

        const prContext = { owner, repoName, branchName, baseBranch, issueNumber, issueTitle, commitMessage, worktreePath, repoUrl, authToken };
        try {
            const existingPRs = await getAuthenticatedOctokit().then(octokit =>
                octokit.request('GET /repos/{owner}/{repo}/pulls', {
                    owner,
                    repo: repoName,
                    head: `${owner}:${branchName}`,
                    state: 'open'
                })
            );

            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                logger.info({ owner, repoName, branchName, prNumber: existingPR.number, prUrl: existingPR.html_url }, 'Found existing PR created by Claude, using it instead of creating new one');
                prInfo = { number: existingPR.number, url: existingPR.html_url, title: existingPR.title, state: existingPR.state };
            } else {
                prInfo = await createNewPRForIssue(prContext, claudeResult);
            }
        } catch (checkError) {
            logger.warn({ error: checkError.message }, 'Failed to check for existing PR, proceeding with creation');
            prInfo = await createNewPRForIssue(prContext, claudeResult);
        }

        await addClaudeLogsComment({
            owner,
            repoName,
            prNumber: prInfo.number,
            claudeResult,
            issueNumber
        });

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
            prNumber: prInfo.number,
            prUrl: prInfo.url
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
                error: labelError.message
            }, 'Failed to update labels after post-processing failure');
        }

        handleError(error, `Post-processing failed for issue #${issueNumber}`);
        throw error;
    }
}
