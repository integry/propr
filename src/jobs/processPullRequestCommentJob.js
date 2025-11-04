import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    createWorktreeFromExistingBranch,
    cleanupWorktree,
    getRepoUrl,
    commitChanges,
    pushBranch
} from '../git/repoManager.js';
import { formatResetTime } from '../utils/scheduling.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { createLogFiles } from '../utils/github/logFiles.js';
import fs from 'fs-extra';
import { executeClaudeCode, UsageLimitError } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue } from '../queue/taskQueue.js';
import Redis from 'ioredis';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10);

export async function processPullRequestCommentJob(job) {
    const {
        pullRequestNumber,
        commentId,
        commentBody,
        commentAuthor,
        comments,
        branchName,
        repoOwner,
        repoName,
        llm,
        correlationId
    } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    
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
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        const botUsername = process.env.GITHUB_BOT_USERNAME || 'github-actions[bot]';
        const prComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            per_page: 100
        });

        unprocessedComments = commentsToProcess.filter(comment => {
            const alreadyProcessed = prComments.some(prComment => {
                const isBotComment = prComment.user.login === botUsername || 
                                    prComment.user.type === 'Bot' ||
                                    prComment.user.login.includes('[bot]');
                
                if (!isBotComment) return false;
                
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

            // Mark task as completed in state manager
            try {
                await stateManager.markTaskCompleted(taskId, {
                    status: 'skipped',
                    reason: 'already_processed'
                });
            } catch (stateError) {
                correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to completed');
            }

            return {
                status: 'skipped',
                reason: 'already_processed',
                pullRequestNumber
            };
        }

        let combinedCommentBody;
        let commentAuthors = [];
        
        if (unprocessedComments.length === 1) {
            combinedCommentBody = unprocessedComments[0].body;
            commentAuthors = [unprocessedComments[0].author];
        } else {
            combinedCommentBody = unprocessedComments.map((comment, index) => {
                return `**Comment ${index + 1}** (by @${comment.author}):\n${comment.body}`;
            }).join('\n\n---\n\n');
            commentAuthors = [...new Set(unprocessedComments.map(c => c.author))];
        }

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

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
            reason: 'Starting PR comment processing'
        });

        await ensureGitRepository(correlatedLogger);

        const { ensureRepoCloned } = await import('../git/repoManager.js');
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const worktreeDirName = `pr-${pullRequestNumber}-followup-${timestamp}`;

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

        claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: { 
                number: pullRequestNumber, 
                repoOwner, 
                repoName 
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: llm || DEFAULT_MODEL_NAME,
            onSessionId: async (sessionId, conversationId) => {
                try {
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
                    
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const logDir = '/tmp/claude-logs';
                    
                    await fs.ensureDir(logDir);
                    
                    const filePrefix = `issue-${pullRequestNumber}-${timestamp}`;
                    const conversationPath = `${logDir}/${filePrefix}-conversation.json`;
                    
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

        await recordLLMMetrics(claudeResult, { 
            number: pullRequestNumber, 
            repoOwner, 
            repoName 
        }, 'pr_comment', correlationId, taskId);

        await createLogFiles(claudeResult, { 
            number: pullRequestNumber, 
            repoOwner, 
            repoName 
        });

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

        let changesSummary = '';
        if (claudeResult.summary) {
            changesSummary = claudeResult.summary;
        } else if (claudeResult.finalResult?.result) {
            changesSummary = claudeResult.finalResult.result;
        }

        let commitDetails = '';
        if (changesSummary) {
            const lines = changesSummary.split('\n');
            const changeLines = lines.filter(line => 
                line.trim().startsWith('-') || 
                line.trim().startsWith('*') || 
                line.trim().startsWith('•') ||
                line.match(/^\d+\./)
            ).slice(0, 10);
            
            if (changeLines.length > 0) {
                commitDetails = '\n\nKey changes:\n' + changeLines.join('\n');
            }
        }

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

            let prCommentBody = `✅ **Applied the requested follow-up changes** in commit ${commitResult.commitHash.substring(0, 7)}\n\n`;
            
            if (unprocessedComments.length > 1) {
                prCommentBody += `Processed ${unprocessedComments.length} comments:\n`;
                unprocessedComments.forEach((comment, index) => {
                    prCommentBody += `- Comment ${index + 1} by @${comment.author} (ID: ${String(comment.id)}✓)\n`;
                });
                prCommentBody += '\n';
            }
            
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

            correlatedLogger.info({
                pullRequestNumber,
                commitHash: commitResult.commitHash,
                commentUrl: completionComment.data.html_url
            }, 'Successfully applied follow-up changes');
        } else {
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
        }

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

            const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
            const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
            const readableResetTime = formatResetTime(error.resetTimestamp);

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

            await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });

        } else {
            handleError(error, 'Failed to process PR comment job', { correlationId });
            
            await stateManager.updateTaskState(taskId, TaskStates.FAILED, {
                reason: 'PR comment processing failed',
                error: error.message
            });
            
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
                } catch (commentError) {
                    correlatedLogger.error({ error: commentError.message }, 'Failed to post error comment');
                }
            }
            
            throw error;
        }
    } finally {
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: false,
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}
