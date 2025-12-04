import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    ensureRepoCloned,
    createWorktreeFromExistingBranch,
    cleanupWorktree,
    getRepoUrl,
    commitChanges,
    pushBranch
} from '../git/repoManager.js';
import { formatResetTime } from '../utils/scheduling.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { createLogFiles } from '../utils/github/logFiles.js';
import { getUsageStats } from '../utils/tokenCalculation.js';
import { db, isEnabled as isDbEnabled } from '../db/postgres.js';
import fs from 'fs-extra';
import { executeClaudeCode, UsageLimitError, generateTaskSummary } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue } from '../queue/taskQueue.js';
import Redis from 'ioredis';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { loadPrLabel } from '../config/configRepoManager.js';
import { filterCommentByAuthor } from '../utils/commentFilters.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10);
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';

// Redis client for pending comments
const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

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

export async function processPullRequestCommentJob(job) {
    const {
        pullRequestNumber,
        commentId,
        commentBody,
        commentAuthor,
        comments,
        branchName: jobBranchName,
        repoOwner,
        repoName,
        llm: jobLlm,
        correlationId
    } = job.data;
    // Model can be overridden by PR labels at processing time
    let llm = jobLlm;
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    const PR_LABEL = await getPrLabel();
    
    const isBatchJob = !!comments && Array.isArray(comments);
    let commentsToProcess = isBatchJob ? [...comments] : [{
        id: commentId,
        body: commentBody,
        author: commentAuthor
    }];

    // Pick up any pending comments from Redis that were queued while another job was active
    const pendingCommentsKey = `pending-pr-comments:${repoOwner}:${repoName}:${pullRequestNumber}`;
    try {
        const pendingComments = await redisClient.lrange(pendingCommentsKey, 0, -1);
        if (pendingComments.length > 0) {
            // Clear the pending list
            await redisClient.del(pendingCommentsKey);

            // Parse and add to comments to process
            for (const commentJson of pendingComments) {
                try {
                    const pendingComment = JSON.parse(commentJson);
                    // Only add if not already in the list
                    if (!commentsToProcess.some(c => c.id === pendingComment.id)) {
                        commentsToProcess.push(pendingComment);
                    }
                } catch (parseError) {
                    correlatedLogger.warn({ error: parseError.message }, 'Failed to parse pending comment');
                }
            }
            correlatedLogger.info({
                pullRequestNumber,
                pendingCount: pendingComments.length,
                totalCount: commentsToProcess.length
            }, 'Picked up pending comments from Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ error: redisError.message }, 'Failed to fetch pending comments from Redis');
    }

    correlatedLogger.info({
        pullRequestNumber,
        branchName: jobBranchName,
        llm,
        isBatchJob,
        commentsCount: commentsToProcess.length
    }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);

    const taskId = job.id;
    const stateManager = getStateManager();
    
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;
    const lockTtlSeconds = 3600;
    
    const currentLock = await stateManager.redis.get(lockKey);
    
    if (currentLock && currentLock !== correlationId) {
        correlatedLogger.info({ 
            lockOwner: currentLock 
        }, 'PR is currently being processed by another job. Rescheduling...');
        
        await issueQueue.add(job.name, job.data, { delay: 10000 });
        
        return { 
            status: 'rescheduled', 
            reason: 'pr_locked_by_other_job' 
        };
    }
    
    await stateManager.redis.set(lockKey, correlationId, 'EX', lockTtlSeconds);
    
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

        const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: repoOwner,
            repo: repoName,
            pull_number: pullRequestNumber
        });

        const botUsername = process.env.GITHUB_BOT_USERNAME || 'gitfixio[bot]';
        const prCommentsForValidation = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: pullRequestNumber,
            per_page: 100
        });

        const reviewCommentsForValidation = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            pull_number: pullRequestNumber,
            per_page: 100
        });

        const allCommentsForValidation = [...prCommentsForValidation, ...reviewCommentsForValidation];

        // Filter out deleted comments and update edited ones
        const validatedComments = [];
        for (const comment of commentsToProcess) {
            const currentComment = allCommentsForValidation.find(c => c.id === comment.id);

            if (!currentComment) {
                correlatedLogger.warn({
                    pullRequestNumber,
                    commentId: comment.id,
                    commentAuthor: comment.author
                }, 'Comment has been deleted, skipping');
                continue; // Skip deleted comments instead of aborting
            }
            
            // Check if comment was edited AFTER the job was queued
            // Update the comment body inline instead of restarting
            const commentWasEditedAfterQueuing = comment.updated_at &&
                currentComment.updated_at !== comment.updated_at;

            if (commentWasEditedAfterQueuing) {
                correlatedLogger.info({
                    pullRequestNumber,
                    commentId: comment.id,
                    commentAuthor: comment.author,
                    originalUpdatedAt: comment.updated_at,
                    currentUpdatedAt: currentComment.updated_at
                }, 'Comment has been edited since job was queued, using updated content');

                // Add the comment with updated body
                validatedComments.push({
                    ...comment,
                    body: currentComment.body,
                    updated_at: currentComment.updated_at
                });
            } else {
                // Comment is unchanged, add as-is
                validatedComments.push(comment);
            }
        }

        // Check if any valid comments remain after filtering
        if (validatedComments.length === 0) {
            correlatedLogger.info({
                pullRequestNumber,
                originalCount: commentsToProcess.length
            }, 'All comments were deleted, nothing to process');

            return {
                status: 'skipped',
                reason: 'all_comments_deleted',
                pullRequestNumber
            };
        }

        // Use validated comments for the rest of processing
        commentsToProcess = validatedComments;
        correlatedLogger.info({
            pullRequestNumber,
            validatedCount: validatedComments.length
        }, 'Comments validated and ready for processing');

        const branchName = jobBranchName || prData.data.head.ref;
        if (!jobBranchName) {
            correlatedLogger.debug({ branchName }, 'Extracted branch name from PR data');
        }

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

        // Extract model from PR labels (refreshed at processing time)
        // This overrides any model specified when the job was queued
        if (prData.data.labels && Array.isArray(prData.data.labels)) {
            const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
            for (const label of prData.data.labels) {
                const labelName = typeof label === 'string' ? label : label.name;
                const match = labelName.match(modelLabelRegex);
                if (match) {
                    llm = resolveModelAlias(match[1]);
                    correlatedLogger.info({
                        pullRequestNumber,
                        label: labelName,
                        resolvedModel: llm
                    }, 'Using model from PR label');
                    break;
                }
            }
        }

        unprocessedComments = commentsToProcess.filter(comment => {
            const alreadyProcessed = prCommentsForValidation.some(prComment => {
                const isBotComment = prComment.user.login === botUsername;
                
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

        let originalTaskSpec = '';
        const linkedIssueMatch = prData.data.body?.match(/(?:closes|fixes|resolves|addresses)\s+#(\d+)/i);
        if (linkedIssueMatch) {
            const linkedIssueNumber = parseInt(linkedIssueMatch[1], 10);
            correlatedLogger.info({ pullRequestNumber, linkedIssueNumber }, 'Found linked issue in PR body');
            
            try {
                const linkedIssueData = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                    owner: repoOwner,
                    repo: repoName,
                    issue_number: linkedIssueNumber
                });
                
                const linkedIssueComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: repoOwner,
                    repo: repoName,
                    issue_number: linkedIssueNumber,
                    per_page: 100
                });
                
                const clarifyingComments = linkedIssueComments.filter(comment => {
                    const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type, correlationId);
                    return !filterResult.shouldFilter;
                });
                
                originalTaskSpec += `Here is the original task specification (GitHub Issue #${linkedIssueNumber}):\n\n`;
                originalTaskSpec += `---\n`;
                originalTaskSpec += `**Issue Title:** ${linkedIssueData.data.title}\n`;
                originalTaskSpec += `**Author:** @${linkedIssueData.data.user.login}\n`;
                originalTaskSpec += `**Body:**\n${formatCommentForPrompt(linkedIssueData.data.body)}\n`;
                originalTaskSpec += `---\n`;
                
                if (clarifyingComments.length > 0) {
                    originalTaskSpec += `\n**Clarifying Comments on Issue #${linkedIssueNumber}:**\n\n`;
                    for (const comment of clarifyingComments) {
                        originalTaskSpec += `---\n`;
                        originalTaskSpec += `**Author:** @${comment.user.login}\n`;
                        originalTaskSpec += `**Comment:**\n${formatCommentForPrompt(comment.body)}\n`;
                        originalTaskSpec += `---\n`;
                    }
                }
                
                originalTaskSpec += '\n';
                
                correlatedLogger.info({
                    pullRequestNumber,
                    linkedIssueNumber,
                    issueTitle: linkedIssueData.data.title,
                    clarifyingCommentsCount: clarifyingComments.length
                }, 'Fetched original task spec from linked issue');
                
            } catch (issueError) {
                correlatedLogger.warn({
                    pullRequestNumber,
                    linkedIssueNumber,
                    error: issueError.message
                }, 'Failed to fetch linked issue data, continuing without it');
            }
        }

        let commentHistory = '';
        const reversedComments = [...commentsByTime].reverse();

        if (reversedComments.length > 0 || prData.data.body) {
            commentHistory += 'Here is the recent comment history on this PR (newest first) for context:\n\n';
        }
        
        if (reversedComments.length > 0) {
            for (const comment of reversedComments) {
                const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type, correlationId);
                if (filterResult.shouldFilter) {
                    continue;
                }
                const author = comment.user.login;
                const body = formatCommentForPrompt(comment.body);
                const commentType = comment.pull_request_review_id ? 'Review Comment' : 'General Comment';
                commentHistory += `---
**Author:** @${author} (${commentType})
**Comment:**
${body}
---\n`;
            }
        }

        if (prData.data.body) {
            const author = prData.data.user.login;
            const body = formatCommentForPrompt(prData.data.body);
            commentHistory += `---
**Author:** @${author} (Original Task Description)
**Comment:**
${body}
---\n`;
        }

        if (commentHistory) {
            commentHistory += '\n';
        }

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

        let summaryTitle = '';
        try {
            const summaryRequest = `Summarize this change request in one sentence, focusing on the main action: ${combinedCommentBody}`;
            summaryTitle = await generateTaskSummary(summaryRequest, worktreeInfo.worktreePath, githubToken.token, { number: pullRequestNumber, repoOwner, repoName }, correlationId, 'haiku');
            correlatedLogger.info({ taskId, summaryTitle }, 'Generated AI summary for follow-up task');
        } catch (summaryError) {
            correlatedLogger.warn({ taskId, error: summaryError.message }, 'Failed to generate AI summary, falling back to truncation.');
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

        const prompt = `You are working on pull request #${pullRequestNumber} to apply follow-up changes.

**New Request${unprocessedComments.length > 1 ? 's' : ''}:**
${combinedCommentBody.replace(/^/gm, '> ')}

${commentHistory}${originalTaskSpec}

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
                repoName,
                title: job.data.title
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
                            conversationId,
                            model: llm || DEFAULT_MODEL_NAME
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
            const { inputTokens, outputTokens, totalTokens } = getUsageStats(claudeResult);
            if (totalTokens > 0) {
                prCommentBody += `- Tokens used: ${totalTokens.toLocaleString()} [${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output]\n`;
            }
            const cost = claudeResult.finalResult?.cost_usd || claudeResult.finalResult?.total_cost_usd;
            if (cost != null) {
                prCommentBody += `- Cost: $${cost.toFixed(2)}\n`;
            }

            prCommentBody += `\n\n---\n_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`;

            completionComment = await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner: repoOwner,
                repo: repoName,
                comment_id: startingWorkComment.data.id,
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
            const { inputTokens: analysisInputTokens, outputTokens: analysisOutputTokens, totalTokens: analysisTotalTokens } = getUsageStats(claudeResult);
            if (analysisTotalTokens > 0) {
                noChangesBody += `- Tokens used: ${analysisTotalTokens.toLocaleString()} [${analysisInputTokens.toLocaleString()} input + ${analysisOutputTokens.toLocaleString()} output]\n`;
            }
            const analysisCost = claudeResult.finalResult?.total_cost_usd || claudeResult.finalResult?.cost_usd;
            if (analysisCost) {
                noChangesBody += `- Cost: $${analysisCost.toFixed(2)}\n`;
            }
            
            noChangesBody += `\n\n---\n_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`;

            completionComment = await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner: repoOwner,
                repo: repoName,
                comment_id: startingWorkComment.data.id,
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
            
            if (octokit && startingWorkComment) {
                try {
                    await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                        owner: repoOwner,
                        repo: repoName,
                        comment_id: startingWorkComment.data.id,
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
        const lockOwner = await stateManager.redis.get(lockKey);
        if (lockOwner === correlationId) {
            await stateManager.redis.del(lockKey);
            correlatedLogger.debug('Released PR processing lock');
        }

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

        // Check if there are pending comments that arrived during processing
        // and queue a follow-up job to handle them
        try {
            const remainingPendingComments = await redisClient.llen(pendingCommentsKey);
            if (remainingPendingComments > 0) {
                correlatedLogger.info({
                    pullRequestNumber,
                    pendingCount: remainingPendingComments
                }, 'Found pending comments that arrived during processing, queuing follow-up job');

                const followUpJobData = {
                    pullRequestNumber,
                    comments: [], // Will be populated from Redis by the job
                    repoOwner,
                    repoName,
                    branchName: jobBranchName,
                    llm: jobLlm,
                    correlationId: generateCorrelationId(),
                };

                const followUpJobId = `pr-comments-batch-${repoOwner}-${repoName}-${pullRequestNumber}-${Date.now()}`;
                await issueQueue.add('processPullRequestComment', followUpJobData, {
                    jobId: followUpJobId,
                    delay: 3000 // Small delay to allow for batching
                });

                correlatedLogger.info({
                    jobId: followUpJobId,
                    pullRequestNumber
                }, 'Queued follow-up job for pending comments');
            }
        } catch (pendingCheckError) {
            correlatedLogger.warn({ error: pendingCheckError.message }, 'Failed to check/queue pending comments');
        }
    }
}
