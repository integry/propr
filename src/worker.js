import 'dotenv/config';
import path from 'path';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker, issueQueue } from './queue/taskQueue.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import { withErrorHandling, handleError, ErrorCategories } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { getStateManager, TaskStates } from './utils/workerStateManager.js';
import { db, isEnabled as isDbEnabled } from './db/postgres.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    createWorktreeFromExistingBranch,
    cleanupWorktree,
    getRepoUrl,
    commitChanges,
    pushBranch
} from './git/repoManager.js';
import { formatResetTime, addModelSpecificDelay } from './utils/scheduling.js';
import { safeRemoveLabel, safeAddLabel, safeUpdateLabels } from './utils/github/labelOperations.js';
import { ensureGitRepository } from './utils/git/gitValidation.js';
import { createLogFiles, generateCompletionComment } from './utils/github/logFiles.js';
import fs from 'fs-extra';
import { completePostProcessing } from './githubService.js';
import { executeClaudeCode, buildClaudeDockerImage, UsageLimitError, generateTaskSummary } from './claude/claudeService.js';
import { generateTaskImportPrompt } from './claude/prompts/promptGenerator.js';
import { recordLLMMetrics } from './utils/llmMetrics.js';
import { 
    validatePRCreation, 
    generateEnhancedClaudePrompt, 
    validateRepositoryInfo 
} from './utils/prValidation.js';
import Redis from 'ioredis';
import { getDefaultModel } from './config/modelAliases.js';
import { loadSettings, loadAiPrimaryTag, loadPrLabel } from './config/configRepoManager.js';
import { processGitHubIssueJob } from './jobs/processGitHubIssueJob.js';

// Configuration
const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

async function getAiPrimaryTag() {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadAiPrimaryTag();
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load AI primary tag from config, using fallback');
    }
    return process.env.AI_PRIMARY_TAG || 'AI';
}

async function getPrLabel() {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadPrLabel();
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load PR label from config, using fallback');
    }
    return process.env.PR_LABEL || 'gitfix';
}

// Buffer to add AFTER the reset timestamp to ensure limit is reset
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10); // 5 minutes buffer
// Jitter to prevent thundering herd if multiple jobs reset at the same time
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10); // 2 minutes jitter







/**
 * Processes a GitHub issue job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
async function processPullRequestCommentJob(job) {
    const {
        pullRequestNumber,
        commentId,
        commentBody,
        commentAuthor,
        comments,  // New batch format
        branchName,
        repoOwner,
        repoName,
        llm,
        correlationId
    } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    const PR_LABEL = await getPrLabel();
    
    // Check if this is a batch job or single comment job
    const isBatchJob = !!comments && Array.isArray(comments);
    const commentsToProcess = isBatchJob ? comments : [{
        id: commentId,
        body: commentBody,
        author: commentAuthor
    }];
    
    correlatedLogger.info({ 
        pullRequestNumber, 
        branchName, 
        llm,
        isBatchJob,
        commentsCount: commentsToProcess.length
    }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);

    const taskId = job.id;
    const stateManager = getStateManager();
    
    try {
        await stateManager.createTaskState(taskId, {
            number: pullRequestNumber,
            repoOwner,
            repoName,
            comments: job.data.comments
        }, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({
            taskId,
            error: stateError.message
        }, 'Failed to create initial task state, continuing anyway');
    }

    let octokit;
    let localRepoPath;
    let worktreeInfo;
    let claudeResult = null;
    let authorsText = '';
    let commentIds = '';
    let unprocessedComments = [];
    let startingWorkComment = null;

    const formatCommentForPrompt = (body) => {
        if (!body) return '[Empty comment]';
        const maxLength = 1000;
        if (body.length > maxLength) {
            return body.substring(0, maxLength) + '... (comment truncated)';
        }
        return body;
    };

    try {
        // Get authenticated Octokit instance
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        // Check if PR has the required label
        const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: repoOwner,
            repo: repoName,
            pull_number: pullRequestNumber
        });
        
        const hasRequiredLabel = prData.data.labels.some(label => label.name === PR_LABEL);
        
        if (!hasRequiredLabel) {
            correlatedLogger.info({
                pullRequestNumber,
                requiredLabel: PR_LABEL
            }, 'PR does not have the required label, skipping follow-up comment processing');
            
            return { 
                status: 'skipped', 
                reason: 'missing_required_label',
                pullRequestNumber 
            };
        }

        // Check if comments have already been processed
        const botUsername = process.env.GITHUB_BOT_USERNAME || 'github-actions[bot]';
        // Fetch ALL PR comments using pagination to ensure we don't miss any
        const prComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            per_page: 100
        });

        // Filter out already processed comments
        unprocessedComments = commentsToProcess.filter(comment => {
            const alreadyProcessed = prComments.some(prComment => {
                const isBotComment = prComment.user.login === botUsername || 
                                    prComment.user.type === 'Bot' ||
                                    prComment.user.login.includes('[bot]');
                
                if (!isBotComment) return false;
                
                // Check if the bot comment references this specific comment ID
                // Look for comment ID with checkmark marker (e.g., "3324906845✓")
                const referencesThisComment = prComment.body.includes(`${String(comment.id)}✓`);
                
                return referencesThisComment;
            });
            
            if (alreadyProcessed) {
                correlatedLogger.debug({
                    pullRequestNumber,
                    commentId: comment.id,
                    commentAuthor: comment.author
                }, 'Comment already processed, filtering out');
            }
            
            return !alreadyProcessed;
        });

        if (unprocessedComments.length === 0) {
            correlatedLogger.info({
                pullRequestNumber,
                originalCount: commentsToProcess.length
            }, 'All PR comments have already been processed, skipping');
            
            return { 
                status: 'skipped', 
                reason: 'already_processed',
                pullRequestNumber 
            };
        }

        // Build combined comment body for prompt
        let combinedCommentBody;
        let commentAuthors = [];
        
        if (unprocessedComments.length === 1) {
            combinedCommentBody = unprocessedComments[0].body;
            commentAuthors = [unprocessedComments[0].author];
        } else {
            // Format multiple comments
            combinedCommentBody = unprocessedComments.map((comment, index) => {
                return `**Comment ${index + 1}** (by @${comment.author}):\n${comment.body}`;
            }).join('\n\n---\n\n');
            commentAuthors = [...new Set(unprocessedComments.map(c => c.author))];
        }

        // Fetch all PR comments (both issue and review comments) for context
        const issueComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            per_page: 100
        });

        const reviewComments = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            pull_number: pullRequestNumber,
            per_page: 100
        });

        const allComments = [
            ...issueComments,
            ...reviewComments
        ];

        const commentsByTime = allComments.sort((a, b) => 
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );

        let commentHistory = '';
        const reversedComments = [...commentsByTime].reverse();
        if (reversedComments.length > 0) {
            commentHistory += 'Here is the recent comment history on this PR (newest first) for context:\n\n';
            for (const comment of reversedComments) {
                const author = comment.user.login;
                const body = formatCommentForPrompt(comment.body);
                const commentType = comment.pull_request_review_id ? 'Review Comment' : 'General Comment';
                commentHistory += `---
**Author:** @${author} (${commentType})
**Comment:**
${body}
---\n`;
            }
            commentHistory += '\n';
        }

        // Post a "starting work" comment with reference to all comment IDs
        commentIds = unprocessedComments.map(c => c.id).join(', ');
        authorsText = commentAuthors.map(a => `@${a}`).join(', ');
        
        startingWorkComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            body: `🔄 **Starting work on follow-up changes** requested by ${authorsText}\n\nI'll analyze the ${unprocessedComments.length} request${unprocessedComments.length > 1 ? 's' : ''} and implement the necessary changes.\n\n---\n_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`,
        });

        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        // Update state to processing
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
            reason: 'Starting PR comment processing'
        });

        // Ensure we're in a valid git repository before proceeding
        await ensureGitRepository(correlatedLogger);

        // Step 1: Ensure repository is cloned
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        // Step 2: Create a worktree from the existing PR branch
        // Generate unique worktree name for this follow-up task
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const worktreeDirName = `pr-${pullRequestNumber}-followup-${timestamp}`;

        // Use the proper function to create worktree from existing branch
        worktreeInfo = await createWorktreeFromExistingBranch(
            localRepoPath,
            branchName,
            worktreeDirName,
            repoOwner,
            repoName
        );

        correlatedLogger.info({ 
            worktreePath: worktreeInfo.worktreePath, 
            branchName: worktreeInfo.branchName 
        }, 'Created worktree from existing PR branch');

        // --- Generate and Store AI Summary Title ---
        // Must be done *after* worktree is created, as the summary service needs it
        let summaryTitle = '';
        try {
            const summaryRequest = `Summarize this change request in one sentence, focusing on the main action: ${combinedCommentBody}`;
            summaryTitle = await generateTaskSummary(summaryRequest, worktreeInfo.worktreePath, githubToken.token, { number: pullRequestNumber, repoOwner, repoName }, correlationId, 'haiku');
            correlatedLogger.info({ taskId, summaryTitle }, 'Generated AI summary for follow-up task');
        } catch (summaryError) {
            correlatedLogger.warn({ taskId, error: summaryError.message }, 'Failed to generate AI summary, falling back to truncation.');
            // Fallback to simple truncation
            if (combinedCommentBody) {
                const firstLine = combinedCommentBody.split('\n')[0].replace(/[^a-zA-Z0-9 ]/g, '').trim();
                summaryTitle = "Follow-up: " + firstLine.substring(0, 75);
                if (firstLine.length > 75) summaryTitle += '...';
            } else {
                summaryTitle = `Follow-up: PR #${pullRequestNumber}`;
            }
        }

        job.data.title = `Followup: ${prData.data.title}`;
        job.data.subtitle = summaryTitle;

        if (isDbEnabled && db) {
            try {
                await db('tasks')
                    .where({ task_id: taskId })
                    .update({ initial_job_data: JSON.stringify(job.data) });
                correlatedLogger.info({ taskId, title: job.data.title, subtitle: job.data.subtitle }, 'Updated task with title/subtitle in DB');
            } catch (dbError) {
                correlatedLogger.warn({ taskId, error: dbError.message }, 'Failed to update task with title/subtitle in DB');
            }
        }
        try {
            const state = await stateManager.getTaskState(taskId);
            if (state) {
                state.issueRef = job.data;
                await stateManager.redis.setex(stateManager.getTaskKey(taskId), stateManager.stateExpiry, JSON.stringify(state));
                correlatedLogger.info({ taskId, title: job.data.title }, 'Updated task with title/subtitle in Redis');
            }
        } catch (redisError) {
            correlatedLogger.warn({ taskId, error: redisError.message }, 'Failed to update task with title/subtitle in Redis');
        }
        // --- End Generate and Store AI Summary Title ---

        // Step 3: Generate prompt for follow-up changes
        const prompt = `You are working on pull request #${pullRequestNumber} to apply follow-up changes.

**New Request${unprocessedComments.length > 1 ? 's' : ''}:**
${combinedCommentBody.replace(/^/gm, '> ')}

${commentHistory}

**CRITICAL INSTRUCTIONS:**
- You are in directory: ${worktreeInfo.worktreePath}
- Analyze the existing code on this branch and the comment history provided above.
- Implement ONLY the changes requested in the **New Request(s)** section.
- DO NOT commit your changes - the system will handle the commit for you
- DO NOT create a new pull request
- The repository is ${repoOwner}/${repoName}

**Context:**
- This is a follow-up to an existing pull request #${pullRequestNumber}.
- Make sure your changes are compatible with the existing modifications on this branch.`;

        // Step 4: Execute Claude Code with the follow-up prompt
        claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: { 
                number: pullRequestNumber, 
                repoOwner, 
                repoName,
                title: job.data.title
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: llm || DEFAULT_MODEL_NAME,
            onSessionId: async (sessionId, conversationId) => {
                try {
                    // Update state immediately when sessionId is detected
                    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                        reason: 'Claude execution started',
                        claudeResult: {
                            sessionId,
                            conversationId
                        },
                        historyMetadata: {
                            sessionId,
                            conversationId
                        }
                    });
                    
                    // Store placeholder log file path in Redis for live-details API
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const logDir = '/tmp/claude-logs';
                    
                    // Ensure log directory exists
                    await fs.ensureDir(logDir);
                    
                    const filePrefix = `issue-${pullRequestNumber}-${timestamp}`;
                    const conversationPath = `${logDir}/${filePrefix}-conversation.json`;
                    
                    // Create placeholder conversation file with initial structure
                    const placeholderConversation = {
                        sessionId: sessionId,
                        conversationId: conversationId,
                        timestamp: new Date().toISOString(),
                        issueNumber: pullRequestNumber,
                        repository: `${repoOwner}/${repoName}`,
                        messages: [],
                        _streaming: true
                    };
                    await fs.writeFile(conversationPath, JSON.stringify(placeholderConversation, null, 2));
                    
                    const redis = new Redis({
                        host: process.env.REDIS_HOST || 'redis',
                        port: process.env.REDIS_PORT || 6379
                    });
                    
                    const logData = {
                        files: {
                            conversation: conversationPath
                        },
                        issueNumber: pullRequestNumber,
                        repository: `${repoOwner}/${repoName}`,
                        timestamp: timestamp,
                        sessionId: sessionId,
                        conversationId: conversationId
                    };
                    
                    if (sessionId) {
                        const sessionKey = `execution:logs:session:${sessionId}`;
                        await redis.set(sessionKey, JSON.stringify(logData), 'EX', 86400 * 30);
                    }
                    
                    if (conversationId) {
                        const conversationKey = `execution:logs:conversation:${conversationId}`;
                        await redis.set(conversationKey, JSON.stringify(logData), 'EX', 86400 * 30);
                    }
                    
                    await redis.quit();
                    
                    correlatedLogger.info({
                        taskId,
                        sessionId,
                        conversationId,
                        conversationPath
                    }, 'Updated task state with sessionId for live tracking');
                } catch (error) {
                    correlatedLogger.warn({
                        error: error.message,
                        taskId,
                        sessionId
                    }, 'Failed to update task state with early sessionId');
                }
            },
            onContainerId: async (containerId, containerName) => {
                try {
                    // Update state with container info for Docker log access
                    await stateManager.updateHistoryMetadata(taskId, 'claude_execution', {
                        containerId,
                        containerName
                    });
                    logger.info({ 
                        taskId, 
                        containerId, 
                        containerName 
                    }, 'Docker container info added to task state');
                } catch (err) {
                    logger.warn({ 
                        taskId, 
                        error: err.message 
                    }, 'Failed to update state with container info');
                }
            }
        });

        // Record LLM metrics for PR comment processing
        await recordLLMMetrics(claudeResult, { 
            number: pullRequestNumber, 
            repoOwner, 
            repoName 
        }, 'pr_comment', correlationId, taskId);

        // Create log files and store in Redis for live-details API
        await createLogFiles(claudeResult, { 
            number: pullRequestNumber, 
            repoOwner, 
            repoName 
        });

        // Update task state with Claude execution result (including sessionId for live tracking)
        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
            reason: 'Claude execution completed',
            claudeResult: {
                success: claudeResult.success,
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId,
                executionTime: claudeResult.executionTime
            },
            historyMetadata: {
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId,
                model: claudeResult.model
            }
        });

        if (!claudeResult.success) {
            throw new Error(`Claude execution failed: ${claudeResult.error || 'Unknown error'}`);
        }

        // Step 5: Commit and push changes
        // Extract a summary from Claude's result
        let changesSummary = '';
        if (claudeResult.summary) {
            changesSummary = claudeResult.summary;
        } else if (claudeResult.finalResult?.result) {
            changesSummary = claudeResult.finalResult.result;
        }

        // Parse the summary to extract key changes
        let commitDetails = '';
        if (changesSummary) {
            // Try to extract bullet points or key changes
            const lines = changesSummary.split('\n');
            const changeLines = lines.filter(line => 
                line.trim().startsWith('-') || 
                line.trim().startsWith('*') || 
                line.trim().startsWith('•') ||
                line.match(/^\d+\./)
            ).slice(0, 10); // Limit to 10 key points
            
            if (changeLines.length > 0) {
                commitDetails = '\n\nKey changes:\n' + changeLines.join('\n');
            }
        }

        // Build commit message with all comment references
        const commentReferences = unprocessedComments.map(c => 
            `Comment by: @${c.author} (ID: ${c.id})`
        ).join('\n');
        
        const commitMessage = `feat(ai): ${changesSummary ? changesSummary.split('\n')[0] : `Apply follow-up changes from PR comment`}

${changesSummary ? changesSummary : `Implemented changes requested by ${authorsText}`}${commitDetails}

PR: #${pullRequestNumber}
${commentReferences}
Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}`;

        const commitResult = await commitChanges(
            worktreeInfo.worktreePath,
            commitMessage,
            { name: 'Claude Code', email: 'claude-code@anthropic.com' },
            pullRequestNumber,
            'Follow-up changes'
        );

        let completionComment;
        if (commitResult) {
            await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
                repoUrl,
                authToken: githubToken.token,
                tokenRefreshFn: async () => {
                    const newToken = await octokit.auth();
                    return newToken.token;
                },
                correlationId
            });

            // Step 6: Add confirmation comment to the PR
            let prCommentBody = `✅ **Applied the requested follow-up changes** in commit ${commitResult.commitHash.substring(0, 7)}\n\n`;
            
            // Add reference to all processed comments
            if (unprocessedComments.length > 1) {
                prCommentBody += `Processed ${unprocessedComments.length} comments:\n`;
                unprocessedComments.forEach((comment, index) => {
                    prCommentBody += `- Comment ${index + 1} by @${comment.author} (ID: ${String(comment.id)}✓)\n`;
                });
                prCommentBody += '\n';
            }
            
            // Add the actual changes summary
            if (changesSummary) {
                const commitBody = commitMessage.split('\n\n').slice(1).join('\n\n').trim();
                if (commitBody) {
                    prCommentBody += `## Summary of Changes\n\n${commitBody}\n\n`;
                } else {
                    prCommentBody += `## Summary of Changes\n\n${changesSummary}\n\n`;
                }
            }
            
            prCommentBody += `---\n`;
            prCommentBody += `🤖 **Implemented by Claude Code**\n`;
            prCommentBody += `- Requested by: ${authorsText}\n`;
            prCommentBody += `- Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}\n`;
            if (claudeResult.finalResult?.num_turns) {
                prCommentBody += `- Turns: ${claudeResult.finalResult.num_turns}\n`;
            }
            if (claudeResult.executionTime) {
                prCommentBody += `- Execution time: ${Math.round(claudeResult.executionTime / 1000)}s\n`;
            }
            const cost = claudeResult.finalResult?.cost_usd || claudeResult.finalResult?.total_cost_usd;
            if (cost != null) {
                prCommentBody += `- Cost: $${cost.toFixed(2)}\n`;
            }

            completionComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner,
                repo: repoName,
                issue_number: pullRequestNumber,
                body: prCommentBody,
            });

            // Keep the "starting work" comment for duplicate detection tracking

            correlatedLogger.info({
                pullRequestNumber,
                commitHash: commitResult.commitHash,
                commentUrl: completionComment.data.html_url
            }, 'Successfully applied follow-up changes');
        } else {
            // No changes were necessary
            let noChangesBody = `ℹ️ **Analyzed the follow-up request** by ${authorsText}\n\n`;
            
            if (changesSummary) {
                noChangesBody += `## Analysis Summary\n\n${changesSummary}\n\n`;
            }
            
            noChangesBody += `No code changes were necessary based on the current state of the branch.\n\n`;
            noChangesBody += `---\n`;
            noChangesBody += `🤖 **Analysis by Claude Code**\n`;
            noChangesBody += `- Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}\n`;
            if (claudeResult.executionTime) {
                noChangesBody += `- Analysis time: ${Math.round(claudeResult.executionTime / 1000)}s\n`;
            }
            const analysisCost = claudeResult.finalResult?.total_cost_usd || claudeResult.finalResult?.cost_usd;
            if (analysisCost) {
                noChangesBody += `- Cost: $${analysisCost.toFixed(2)}\n`;
            }
            
            completionComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner,
                repo: repoName,
                issue_number: pullRequestNumber,
                body: noChangesBody,
            });

            // Keep the "starting work" comment for duplicate detection tracking
        }

        // Update task state to completed
        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: 'PR comment processing completed successfully',
            commitHash: commitResult?.commitHash,
            historyMetadata: {
                githubComment: {
                    url: completionComment.data.html_url,
                    body: completionComment.data.body
                }
            }
        });

        return { 
            status: 'complete', 
            commit: commitResult?.commitHash,
            pullRequestNumber,
            claudeResult
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            correlatedLogger.warn({
                pullRequestNumber,
                resetTimestamp: error.resetTimestamp
            }, 'Claude usage limit hit during PR comment processing. Requeueing job.');

            const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000); // Default to 1 hour if timestamp parse failed
            const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
            const readableResetTime = formatResetTime(error.resetTimestamp);

            // Add comment to PR notifying user
            if (octokit) {
                try {
                    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                        owner: repoOwner,
                        repo: repoName,
                        issue_number: pullRequestNumber,
                        body: `⌛ **Processing Delayed:** Claude's usage limit was reached while processing requests from ${authorsText}.
                        
The job has been automatically rescheduled and will restart ${readableResetTime}.

---
*Job ID: ${job.id} will run again after delay.*`
                    });
                } catch (commentError) {
                    correlatedLogger.error({ error: commentError.message }, 'Failed to post usage limit delay comment to PR.');
                }
            }

            // Re-add the job to the queue with the calculated delay
            await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
            
            // Do NOT throw the error, as this job is technically "handled" by being requeued.
            // BullMQ would retry it immediately if we throw.

        } else {
            // Handle all other errors
            handleError(error, 'Failed to process PR comment job', { correlationId });
            
            // Update task state to failed
            await stateManager.updateTaskState(taskId, TaskStates.FAILED, {
                reason: 'PR comment processing failed',
                error: error.message
            });
            
            // Record LLM metrics even if the job failed, as long as Claude was executed
            if (claudeResult) {
                try {
                    await recordLLMMetrics(claudeResult, { 
                        number: pullRequestNumber, 
                        repoOwner, 
                        repoName 
                    }, 'pr_comment', correlationId, taskId);
                    correlatedLogger.info({
                        correlationId,
                        pullRequestNumber
                    }, 'LLM metrics recorded for failed PR comment job');
                } catch (metricsError) {
                    correlatedLogger.error({
                        error: metricsError.message,
                        correlationId
                    }, 'Failed to record LLM metrics for failed PR comment job');
                }
            }
            
            // Add error comment to the PR
            if (octokit) {
                try {
                    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                        owner: repoOwner,
                        repo: repoName,
                        issue_number: pullRequestNumber,
                        body: `❌ **Failed to apply follow-up changes** requested by ${authorsText}

An error occurred while processing your request:

\`\`\`
${error.message}
\`\`\`

---
Comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}
Please check the logs for more details.`,
                    });

                    // Keep the "starting work" comment for duplicate detection tracking even on error
                } catch (commentError) {
                    correlatedLogger.error({ error: commentError.message }, 'Failed to post error comment');
                }
            }
            
            throw error; // Re-throw general errors so BullMQ marks the job as failed
        }
    } finally {
        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: false, // Never delete the branch for PR follow-ups
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}

/**
 * Processes a task import job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
async function processTaskImportJob(job) {
    const { id: jobId, name: jobName, data } = job;
    const {
        taskDescription,
        repository,
        correlationId,
        user
    } = data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager(jobId);
    
    correlatedLogger.info({ 
        jobId,
        jobName,
        repository, 
        user,
        taskDescriptionLength: taskDescription?.length || 0,
        taskDescriptionPreview: taskDescription?.substring(0, 100) + '...'
    }, 'Processing task import job...');

    let octokit;
    let localRepoPath;
    let worktreeInfo;

    try {
        // Phase 1: Setup
        await stateManager.updateState(TaskStates.SETUP, 'Initializing task import process');
        
        // Get authenticated Octokit instance
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        // Parse repository into owner and name
        const [repoOwner, repoName] = repository.split('/');
        
        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        // Ensure we're in a valid git repository before proceeding
        await ensureGitRepository(correlatedLogger);

        // Step 1: Ensure repository is cloned
        await stateManager.updateState(TaskStates.SETUP, 'Cloning repository if needed');
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        // Step 2: Create a worktree for the task import analysis
        await stateManager.updateState(TaskStates.SETUP, 'Creating worktree for analysis');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const worktreeDirName = `task-import-${timestamp}`;

        // Use placeholder values for issue-specific parameters
        worktreeInfo = await createWorktreeForIssue(
            localRepoPath,
            'import', // issueNumber placeholder
            'Task Import Analysis', // title
            repoOwner,
            repoName,
            null, // Use auto-detected default branch
            octokit,
            'planner' // modelName placeholder
        );

        correlatedLogger.info({ 
            worktreePath: worktreeInfo.worktreePath, 
            branchName: worktreeInfo.branchName 
        }, 'Created worktree for task import analysis');

        // Phase 2: AI Processing
        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Generating task import prompt');
        
        // Step 3: Generate the task import prompt
        const prompt = generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreeInfo.worktreePath);

        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Executing Claude analysis');
        
        // Step 4: Execute Claude Code with the task import prompt
        const claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: { 
                number: 'import', // placeholder
                repoOwner, 
                repoName 
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: 'claude-3-5-sonnet-20241022' // Use a specific model for planning
        });

        correlatedLogger.info({
            success: claudeResult.success,
            executionTime: claudeResult.executionTime,
            conversationTurns: claudeResult.conversationLog?.length || 0
        }, 'Claude task import analysis completed');

        // Log the result (this is a fire-and-forget job)
        if (claudeResult.success) {
            correlatedLogger.info({
                repository,
                user,
                stdout: claudeResult.output?.rawOutput || claudeResult.output
            }, 'Task import job completed successfully - Claude executed gh commands');
        } else {
            correlatedLogger.error({
                repository,
                user,
                error: claudeResult.error
            }, 'Task import job failed');
        }
        
        // Phase 3: Cleanup
        await stateManager.updateState(TaskStates.CLEANUP, 'Cleaning up worktree');
        await stateManager.updateState(TaskStates.COMPLETED, 'Task import completed successfully');

        return { 
            status: 'complete', 
            repository,
            success: claudeResult.success,
            jobId,
            claudeResult: {
                success: claudeResult.success,
                executionTime: claudeResult.executionTime,
                conversationTurns: claudeResult.conversationLog?.length || 0,
                stdout: claudeResult.output?.rawOutput || claudeResult.output
            }
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            correlatedLogger.warn({
                repository,
                resetTimestamp: error.resetTimestamp
            }, 'Claude usage limit hit during task import processing. Requeueing job.');

            const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
            const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);

            // Re-add the job to the queue with delay
            await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
            
            // Don't throw - job is handled by requeueing
            return { 
                status: 'requeued', 
                repository,
                delay
            };
        } else {
            // Handle all other errors
            correlatedLogger.error({
                error: error.message,
                stack: error.stack
            }, 'Task import job failed');
            
            await stateManager.updateState(TaskStates.FAILED, `Task import failed: ${error.message}`);
            
            handleError(error, 'Failed to process task import job', { correlationId });
            throw error;
        }
    } finally {
        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: true, // Always delete branch for task imports
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}


/**
 * Creates log files for detailed Claude execution data
 * @param {Object} claudeResult - Result from Claude Code execution
 * @param {Object} issueRef - Issue reference
 * @returns {Promise<Object>} File paths and metadata
 */

/**
 * Resets all worker-related queue data
 */
async function resetWorkerQueues() {
    logger.info('Resetting worker queue data...');
    
    try {
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        // Get all keys related to our queue
        const queueName = GITHUB_ISSUE_QUEUE_NAME;
        const keys = await redis.keys(`bull:${queueName}:*`);
        
        if (keys.length > 0) {
            logger.info({
                queueName,
                keysCount: keys.length
            }, 'Found worker queue keys to delete');
            
            // Delete all queue-related keys
            await redis.del(...keys);
            
            logger.info({
                queueName,
                deletedKeys: keys.length
            }, 'Successfully cleared all worker queue data');
        } else {
            logger.info({ queueName }, 'No worker queue data found to clear');
        }
        
        // Clean up Redis connection
        await redis.quit();
        
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to reset worker queue data');
        throw error;
    }
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        reset: false,
        help: false
    };
    
    for (const arg of args) {
        switch (arg) {
            case '--reset':
                options.reset = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                if (arg.startsWith('--')) {
                    logger.warn({ argument: arg }, 'Unknown command line argument');
                }
        }
    }
    
    return options;
}

/**
 * Display help information
 */
function showHelp() {
    console.log(`
GitHub Issue Worker

Usage: node src/worker.js [options]

Options:
  --reset    Clear all queue data before starting worker
  --help     Show this help message

Examples:
  node src/worker.js                 # Start worker normally
  node src/worker.js --reset         # Reset queues and start worker
`);
}

/**
 * Starts the worker process
 */
async function startWorker(options = {}) {
    const workerId = `worker:${generateCorrelationId()}`;
    let workerConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
    let aiPrimaryTag = 'AI';

    try {
        if (process.env.CONFIG_REPO) {
            const settings = await loadSettings();
            if (settings.worker_concurrency && typeof settings.worker_concurrency === 'number') {
                workerConcurrency = settings.worker_concurrency;
                logger.info({ concurrency: workerConcurrency }, 'Successfully loaded worker_concurrency from config repo');
            } else {
                logger.info({ concurrency: workerConcurrency }, 'Using worker_concurrency from environment variable');
            }
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load settings from config, using environment variable for worker_concurrency');
    }

    // Load AI primary tag
    try {
        aiPrimaryTag = await getAiPrimaryTag();
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load AI primary tag, using default');
    }

    logger.info({
        queue: GITHUB_ISSUE_QUEUE_NAME,
        processingTag: AI_PROCESSING_TAG,
        primaryTag: aiPrimaryTag,
        doneTag: AI_DONE_TAG,
        concurrency: workerConcurrency,
        resetPerformed: options.reset || false
    }, 'Starting GitHub Issue Worker...');
    
    // Run database migrations if enabled
    if (isDbEnabled && db) {
        try {
            logger.info('Running database migrations...');
            await db.migrate.latest();
            logger.info('Database migrations completed successfully');
        } catch (error) {
            logger.error({
                error: error.message,
                stack: error.stack
            }, 'Database migration failed - worker will continue but database persistence may not work');
        }
    }
    
    // Initialize Redis connection for heartbeat
    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy: times => Math.min(times * 50, 2000)
    });
    
    // Function to send heartbeat
    const sendHeartbeat = async () => {
        try {
            await heartbeatRedis.sadd('system:status:workers', workerId);
            await heartbeatRedis.expire('system:status:workers', 90);
            logger.debug('Worker heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send worker heartbeat');
        }
    };
    
    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval (every 30 seconds)
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);
    
    // Ensure Claude Docker image is built before starting worker
    logger.info('Checking Claude Code Docker image...');
    const imageReady = await buildClaudeDockerImage();
    
    if (!imageReady) {
        logger.error('Failed to build Claude Code Docker image. Worker may not function properly.');
        // Continue anyway - worker can still handle Git operations
    } else {
        logger.info('Claude Code Docker image is ready');
    }
    
    const worker = createWorker(GITHUB_ISSUE_QUEUE_NAME, async (job) => {
        if (job.name === 'processGitHubIssue') {
            return processGitHubIssueJob(job);
        } else if (job.name === 'processPullRequestComment') {
            return processPullRequestCommentJob(job);
        } else if (job.name === 'processTaskImport') {
            return processTaskImportJob(job);
        } else {
            throw new Error(`Unknown job type: ${job.name}`);
        }
    }, { concurrency: workerConcurrency });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Worker received SIGINT, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Worker received SIGTERM, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    return worker;
}

// Export for testing
export { processGitHubIssueJob, processPullRequestCommentJob, processTaskImportJob, startWorker };

// Start worker if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArguments();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    async function main() {
        try {
            if (options.reset) {
                logger.info('Reset flag detected, clearing worker queue data...');
                await resetWorkerQueues();
                logger.info('Worker reset completed successfully');
            }
            
            await startWorker(options);
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to start worker');
            process.exit(1);
        }
    }
    
    main();
}