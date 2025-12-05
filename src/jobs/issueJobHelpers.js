import { ErrorCategories } from '../utils/errorHandler.js';
import { safeRemoveLabel } from '../utils/github/labelOperations.js';
import { generateCompletionComment } from '../utils/github/logFiles.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { formatResetTime } from '../utils/scheduling.js';
import { issueQueue } from '../queue/taskQueue.js';
import { db, isEnabled as isDbEnabled } from '../db/postgres.js';

export const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10);
export const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10);

export function calculateUsageLimitDelay(error) {
    const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
    return (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
}

export async function handleSimpleUsageLimitError(error, job, correlatedLogger, repository) {
    correlatedLogger.warn({ repository, resetTimestamp: error.resetTimestamp }, 'Claude usage limit hit during processing. Requeueing job.');
    const delay = calculateUsageLimitDelay(error);
    await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
    return { status: 'requeued', repository, delay };
}

export async function handleUsageLimitError(error, job, issueRef, options = {}) {
    const { octokit, correlatedLogger, stateManager, taskId } = options;
    const jobId = job.id;
    
    correlatedLogger.warn({
        jobId,
        issueNumber: issueRef.number,
        resetTimestamp: error.resetTimestamp
    }, 'Claude usage limit hit during issue processing. Requeueing job.');

    const delay = calculateUsageLimitDelay(error);
    const readableResetTime = formatResetTime(error.resetTimestamp);

    if (octokit) {
        try {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: `⌛ **Processing Delayed:** Claude's usage limit was reached while processing this issue.
                
The job has been automatically rescheduled and will restart ${readableResetTime}.
    
---
*Job ID: ${jobId} will run again after delay.*`
            });
        } catch (commentError) {
            correlatedLogger.error({ error: commentError.message }, 'Failed to post usage limit delay comment to issue.');
        }
    }

    await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });

    try {
        await stateManager.markTaskFailed(taskId, error, { 
            errorCategory: ErrorCategories.CLAUDE_EXECUTION,
            processingStage: 'claude_execution',
            requeued: true,
            delay: delay
        });
    } catch (stateError) {
        correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed (requeued)');
    }
}

export async function handleGenericError(error, job, issueRef, options = {}) {
    const { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG } = options;
    const jobId = job.id;
    const correlationId = issueRef.correlationId;
    
    const errorCategory = error.message?.includes('authentication') ? 'auth_error' :
                         error.message?.includes('network') ? 'network_error' :
                         error.message?.includes('git') ? 'git_error' :
                         error.message?.includes('GitHub') ? 'github_api_error' :
                         error.message?.includes('timeout') ? 'timeout_error' :
                         'unknown_error';
    
    correlatedLogger.error({ 
        jobId, 
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        correlationId,
        taskId,
        errMessage: error.message, 
        stack: error.stack,
        status: 'system_error',
        resolution: 'failed',
        failureCategory: errorCategory,
        claudeAttempted: !!claudeResult,
        claudeSuccess: claudeResult?.success || false,
        worktreeCreated: !!worktreeInfo,
        timestamp: new Date().toISOString(),
        systemVersion: process.env.npm_package_version || 'unknown'
    }, 'Error processing GitHub issue job - enhanced error metrics logged');
    
    if (claudeResult) {
        try {
            await recordLLMMetrics(claudeResult, issueRef, { jobType: 'issue', correlationId, taskId });
            correlatedLogger.info({ correlationId, issueNumber: issueRef.number }, 'LLM metrics recorded for failed job');
        } catch (metricsError) {
            correlatedLogger.error({ error: metricsError.message, correlationId }, 'Failed to record LLM metrics for failed job');
        }
    }
    
    if (octokit) {
        await postErrorComment(issueRef, error, { octokit, errorCategory, claudeResult, worktreeInfo, AI_PROCESSING_TAG, correlatedLogger });
    }
    
    try {
        await stateManager.markTaskFailed(taskId, error, { 
            errorCategory,
            processingStage: claudeResult ? 'post_processing' : 'pre_processing'
        });
    } catch (stateError) {
        correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed');
    }
}

async function postErrorComment(issueRef, error, options = {}) {
    const { octokit, errorCategory, claudeResult, worktreeInfo, AI_PROCESSING_TAG, correlatedLogger } = options;
    try {
        let errorMessage = `❌ **Failed to process this issue**\n\n`;
        errorMessage += `**Error Category:** ${errorCategory.replace('_', ' ')}\n`;
        errorMessage += `**Error Message:** ${error.message}\n\n`;
        
        if (errorCategory === 'git_error') {
            errorMessage += `This appears to be a Git-related issue. The system may have encountered a corrupted repository or git operation failure. `;
            errorMessage += `The issue will be automatically retried, and any corrupted repositories will be cleaned up.\n\n`;
        } else if (errorCategory === 'auth_error') {
            errorMessage += `This is an authentication issue. Please ensure the GitHub token has proper permissions.\n\n`;
        } else if (errorCategory === 'network_error') {
            errorMessage += `This is a network connectivity issue. The system will automatically retry.\n\n`;
        }
        
        errorMessage += `**Processing Stage:** ${claudeResult ? 'Post-processing (after AI analysis)' : 'Pre-processing (before AI analysis)'}\n`;
        
        if (worktreeInfo) {
            errorMessage += `**Branch:** ${worktreeInfo.branchName}\n`;
        }
        
        errorMessage += `\n<details><summary>Technical Details</summary>\n\n`;
        errorMessage += `\`\`\`\n${error.stack || error.message}\n\`\`\`\n`;
        errorMessage += `</details>\n\n`;
        errorMessage += `---\n*The system will automatically retry this task. If the issue persists, please contact support.*`;
        
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
            body: errorMessage
        });
        
        await safeRemoveLabel(
            { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
            AI_PROCESSING_TAG
        );
        
    } catch (commentError) {
        correlatedLogger.error({ error: commentError.message, issueNumber: issueRef.number }, 'Failed to post error comment to GitHub issue');
    }
}

export async function updateTaskTitleInStorage(taskId, issueRef, stateManager, correlatedLogger) {
    if (isDbEnabled && db) {
        try {
            await db('tasks')
                .where({ task_id: taskId })
                .update({ initial_job_data: JSON.stringify(issueRef) });
            correlatedLogger.info({ taskId, title: issueRef.title }, 'Updated task with title/subtitle in DB');
        } catch (dbError) {
            correlatedLogger.warn({ taskId, error: dbError.message }, 'Failed to update task with title/subtitle in DB');
        }
    }
    try {
        const state = await stateManager.getTaskState(taskId);
        if (state) {
            state.issueRef = issueRef;
            await stateManager.redis.setex(stateManager.getTaskKey(taskId), stateManager.stateExpiry, JSON.stringify(state));
            correlatedLogger.info({ taskId, title: issueRef.title }, 'Updated task with title/subtitle in Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ taskId, error: redisError.message }, 'Failed to update task with title/subtitle in Redis');
    }
}

export async function createPullRequest(octokit, issueRef, worktreeInfo, options = {}) {
    const { commitResult, claudeResult, modelName, repoValidation, PR_LABEL, correlatedLogger } = options;
    const jobId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}`;
    
    let prTitle = `AI Analysis for Issue #${issueRef.number}: ${issueRef.title?.replace('New Issue: ', '') || 'Issue'}`;
    if (commitResult) {
        prTitle = `AI Fix for Issue #${issueRef.number}: ${issueRef.title?.replace('New Issue: ', '') || 'Issue'}`;
    }

    const completionComment = await generateCompletionComment(claudeResult, issueRef);
    const prBody = `## AI Implementation Summary

${commitResult ? `Closes #${issueRef.number}` : `Addresses #${issueRef.number}`}

**Model Used:** ${modelName}
**Status:** ${claudeResult?.success ? '✅ Implementation Completed' : '⚠️ Analysis Completed'}
**Branch:** \`${worktreeInfo.branchName}\`
**Commits:** ${commitResult ? `✅ Changes committed (${commitResult.commitHash.substring(0, 7)})` : '❌ No changes made'}

---

${completionComment}

---

*This PR was created automatically by Claude Code after processing issue #${issueRef.number}.*`;

    try {
        const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            title: prTitle,
            head: worktreeInfo.branchName,
            base: issueRef.baseBranch || repoValidation.repoData.defaultBranch,
            body: prBody,
            draft: false
        });

        correlatedLogger.info({
            jobId,
            issueNumber: issueRef.number,
            prNumber: prResponse.data.number,
            prUrl: prResponse.data.html_url
        }, 'PR created successfully');

        const labelsToAdd = [PR_LABEL];
        if (issueRef.baseLabel) labelsToAdd.push(issueRef.baseLabel);
        if (issueRef.modelLabel) labelsToAdd.push(issueRef.modelLabel);

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: prResponse.data.number,
            labels: labelsToAdd
        });

        return {
            success: true,
            pr: {
                number: prResponse.data.number,
                url: prResponse.data.html_url,
                title: prResponse.data.title
            },
            updatedLabels: []
        };

    } catch (prError) {
        correlatedLogger.warn({
            jobId,
            issueNumber: issueRef.number,
            branchName: worktreeInfo.branchName,
            error: prError.message
        }, 'Direct PR creation failed, checking if PR already exists...');

        return await findExistingPR(octokit, issueRef, worktreeInfo, { prError, correlatedLogger });
    }
}

async function findExistingPR(octokit, issueRef, worktreeInfo, options = {}) {
    const { prError, correlatedLogger } = options;
    try {
        const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`,
            state: 'open'
        });

        if (existingPRs.data.length > 0) {
            const existingPR = existingPRs.data[0];
            correlatedLogger.info({
                issueNumber: issueRef.number,
                prNumber: existingPR.number,
                prUrl: existingPR.html_url
            }, 'Found existing PR for branch');

            return {
                success: true,
                pr: {
                    number: existingPR.number,
                    url: existingPR.html_url,
                    title: existingPR.title
                },
                updatedLabels: []
            };
        } else {
            throw prError;
        }
    } catch {
        throw prError;
    }
}

function determineFinalStatus(claudeResult, postProcessingResult) {
    if (!claudeResult?.success) return 'claude_processing_failed';
    return postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes';
}

function buildClaudeResultSection(claudeResult) {
    return {
        success: claudeResult?.success || false,
        executionTime: claudeResult?.executionTime || 0,
        modifiedFiles: claudeResult?.modifiedFiles || [],
        conversationLog: claudeResult?.conversationLog || [],
        error: claudeResult?.error || null,
        sessionId: claudeResult?.sessionId || null,
        conversationId: claudeResult?.conversationId || null,
        model: claudeResult?.model || null
    };
}

export function buildFinalResult(issueRef, localRepoPath, results) {
    const { worktreeInfo, claudeResult, postProcessingResult } = results;

    return {
        status: determineFinalStatus(claudeResult, postProcessingResult),
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        gitSetup: {
            localRepoPath: localRepoPath,
            worktreeCreated: !!worktreeInfo,
            branchName: worktreeInfo?.branchName
        },
        claudeResult: buildClaudeResultSection(claudeResult),
        postProcessing: {
            success: !!postProcessingResult,
            pr: postProcessingResult?.pr || null,
            updatedLabels: postProcessingResult?.updatedLabels || []
        }
    };
}
