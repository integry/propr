import path from 'path';
import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl,
    commitChanges,
    pushBranch
} from '../git/repoManager.js';
import { formatResetTime, addModelSpecificDelay } from '../utils/scheduling.js';
import { safeRemoveLabel, safeAddLabel, safeUpdateLabels } from '../utils/github/labelOperations.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { createLogFiles, generateCompletionComment } from '../utils/github/logFiles.js';
import fs from 'fs-extra';
import { executeClaudeCode, UsageLimitError } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { 
    validatePRCreation, 
    generateEnhancedClaudePrompt, 
    validateRepositoryInfo 
} from '../utils/prValidation.js';
import Redis from 'ioredis';
import { getDefaultModel } from '../config/modelAliases.js';
import { db, isEnabled as isDbEnabled } from '../db/postgres.js';
import { issueQueue } from '../queue/taskQueue.js';
import { ErrorCategories } from '../utils/errorHandler.js';
import { loadAiPrimaryTag, loadPrLabel, loadPrimaryProcessingLabels } from '../config/configRepoManager.js';

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

async function getPrimaryProcessingLabels() {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadPrimaryProcessingLabels();
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load primary processing labels from config, using fallback');
    }
    
    if (process.env.PRIMARY_PROCESSING_LABELS) {
        return process.env.PRIMARY_PROCESSING_LABELS.split(',').map(l => l.trim()).filter(l => l);
    }
    
    return [process.env.AI_PRIMARY_TAG || 'AI'];
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

const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10);

async function processGitHubIssueJob(job) {
    // --- Matrix Dispatcher Check ---
    if (!job.data.isChildJob) {
        // This is an original job, act as dispatcher
        return await handleDispatch(job);
    }
    // --- Child Job Execution ---
    // All existing code now only runs for child jobs
    const { id: jobId, name: jobName, data: issueRef } = job;
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();
    
    const primaryProcessingLabels = await getPrimaryProcessingLabels();
    const triggeringLabel = issueRef.triggeringLabel || primaryProcessingLabels[0] || 'AI';
    const AI_PROCESSING_TAG = `${triggeringLabel}-processing`;
    const AI_DONE_TAG = `${triggeringLabel}-done`;
    const AI_PRIMARY_TAG = triggeringLabel;
    const PR_LABEL = await getPrLabel();
    
    const modelName = issueRef.modelName || 'default';
    await addModelSpecificDelay(modelName);
    
    correlatedLogger.debug({ 
        jobId, 
        modelName,
        delayApplied: true
    }, 'Applied model-specific delay to prevent conflicts');
    
    const taskId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${modelName}`;
    
    try {
        await stateManager.createTaskState(taskId, issueRef, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({
            taskId,
            error: stateError.message
        }, 'Failed to create task state, continuing anyway');
    }
    
    correlatedLogger.info({ 
        jobId, 
        jobName, 
        taskId,
        issueNumber: issueRef.number, 
        repo: `${issueRef.repoOwner}/${issueRef.repoName}` 
    }, 'Processing job started');

    let octokit;
    try {
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );
    } catch (authError) {
        const errorDetails = handleError(authError, 'Worker: Failed to get authenticated Octokit instance', { 
            correlationId, 
            issueRef 
        });
        
        try {
            await stateManager.markTaskFailed(taskId, authError, { 
                errorCategory: errorDetails.category 
            });
        } catch (stateError) {
            correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed');
        }
        
        throw authError;
    }

    let localRepoPath;
    let worktreeInfo;
    let claudeResult = null;
    let postProcessingResult = null;
    let commitResult = null;

    try {
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
            reason: 'Starting issue processing'
        });
        
        const currentIssueData = await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
            }),
            { ...retryConfigs.githubApi, correlationId },
            `get_issue_${issueRef.number}`
        );

        const currentLabels = currentIssueData.data.labels.map(label => label.name);
        const hasProcessingTag = currentLabels.includes(AI_PROCESSING_TAG);
        const hasPrimaryTag = currentLabels.includes(AI_PRIMARY_TAG);
        const hasDoneTag = currentLabels.includes(AI_DONE_TAG);

        if (!hasPrimaryTag) {
            logger.warn({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Issue no longer has primary tag '${AI_PRIMARY_TAG}'. Skipping.`);
            return { 
                status: 'skipped', 
                reason: 'Primary tag missing',
                issueNumber: issueRef.number 
            };
        }

        if (hasDoneTag) {
            logger.warn({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Issue already has '${AI_DONE_TAG}' tag. Skipping.`);
            return { 
                status: 'skipped', 
                reason: 'Already done',
                issueNumber: issueRef.number 
            };
        }

        if (!hasProcessingTag) {
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Adding '${AI_PROCESSING_TAG}' tag to issue`);
            
            await safeAddLabel(octokit, issueRef.repoOwner, issueRef.repoName, issueRef.number, AI_PROCESSING_TAG, correlatedLogger);
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Successfully added '${AI_PROCESSING_TAG}' tag`);
        } else {
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number 
            }, `Issue already has '${AI_PROCESSING_TAG}' tag, continuing with processing`);
        }

        // --- Store Issue Title and Subtitle ---
        const issueTitle = currentIssueData.data.title;
        const issueSubtitle = `Preparing a PR for issue #${issueRef.number}`;
        
        issueRef.title = `New Issue: ${issueTitle}`;
        issueRef.subtitle = issueSubtitle;
        
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
        // --- End Store Title/Subtitle ---

        logger.info({ 
            jobId, 
            issueNumber: issueRef.number 
        }, 'Starting Git environment setup...');

        await job.updateProgress(25);
        
        logger.info({ 
            jobId, 
            owner: issueRef.repoOwner, 
            repo: issueRef.repoName 
        }, 'Validating repository access...');
        
        const repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
        
        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl(issueRef);
        
        try {
            await ensureGitRepository(correlatedLogger);
            
            logger.info({ 
                jobId, 
                repo: `${issueRef.repoOwner}/${issueRef.repoName}`,
                repoUrl 
            }, 'Cloning/updating repository...');
            
            localRepoPath = await ensureRepoCloned(
                repoUrl, 
                issueRef.repoOwner, 
                issueRef.repoName, 
                githubToken.token
            );
            
            await job.updateProgress(50);
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                issueTitle: currentIssueData.data.title,
                localRepoPath,
                modelName
            }, 'Creating Git worktree for issue...');
            
            worktreeInfo = await createWorktreeForIssue(
                localRepoPath,
                issueRef.number,
                currentIssueData.data.title,
                issueRef.repoOwner,
                issueRef.repoName,
                null,
                octokit,
                modelName
            );
            
            await job.updateProgress(75);
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath,
                branchName: worktreeInfo.branchName
            }, 'Git environment setup complete');
            
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: `🤖 AI processing has started for this issue using **${modelName}** model.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.\n\n**Processing Details:**\n- Model: \`${modelName}\`\n- Branch: \`${worktreeInfo.branchName}\`\n- Base Branch: \`${repoValidation.repoData.defaultBranch}\`\n- Worktree: \`${worktreeInfo.worktreePath.split('/').pop()}\``,
            });
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName
            }, 'Pushing initial branch to GitHub...');
            
            await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
                repoUrl,
                authToken: githubToken.token,
                tokenRefreshFn: async () => {
                    const newToken = await octokit.auth();
                    return newToken.token;
                },
                correlationId
            });
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName
            }, 'Initial branch pushed successfully');
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath
            }, 'Starting Claude Code execution...');
            
            await job.updateProgress(80);
            
            correlatedLogger.info({
                jobId,
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath
            }, 'EXECUTION DEBUG: About to execute Claude Code');

            let issueComments = [];
            try {
                const allComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                    per_page: 100
                });
                
                const botUsername = process.env.GITHUB_BOT_USERNAME || 'gitfixio[bot]';
                issueComments = allComments.filter(comment => {
                    const isBot = comment.user.login === botUsername;
                    return !isBot;
                });
                
                correlatedLogger.info({
                    issueNumber: issueRef.number,
                    totalComments: allComments.length,
                    filteredComments: issueComments.length,
                    botCommentsRemoved: allComments.length - issueComments.length
                }, 'Fetched and filtered issue comments for Claude');
            } catch (commentError) {
                correlatedLogger.warn({
                    issueNumber: issueRef.number,
                    error: commentError.message
                }, 'Failed to fetch issue comments, continuing without them');
            }

            claudeResult = await executeClaudeCode({
                worktreePath: worktreeInfo.worktreePath,
                issueRef: issueRef,
                githubToken: githubToken.token,
                branchName: worktreeInfo.branchName,
                modelName: modelName,
                issueDetails: {
                    title: currentIssueData.data.title,
                    body: currentIssueData.data.body,
                    comments: issueComments,
                    labels: currentIssueData.data.labels,
                    created_at: currentIssueData.data.created_at,
                    updated_at: currentIssueData.data.updated_at,
                    user: currentIssueData.data.user
                },
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
                                model: modelName
                            }
                        });
                        
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const logDir = '/tmp/claude-logs';
                        
                        await fs.ensureDir(logDir);
                        
                        const filePrefix = `issue-${issueRef.number}-${timestamp}`;
                        const conversationPath = `${logDir}/${filePrefix}-conversation.json`;
                        
                        const placeholderConversation = {
                            sessionId: sessionId,
                            conversationId: conversationId,
                            timestamp: new Date().toISOString(),
                            issueNumber: issueRef.number,
                            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
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
                            issueNumber: issueRef.number,
                            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
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
                        correlatedLogger.info({ 
                            taskId, 
                            containerId, 
                            containerName 
                        }, 'Docker container info added to task state');
                    } catch (err) {
                        correlatedLogger.warn({ 
                            taskId, 
                            error: err.message 
                        }, 'Failed to update state with container info');
                    }
                }
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
            
            await recordLLMMetrics(claudeResult, issueRef, 'issue', correlationId, taskId);
            
            correlatedLogger.info({
                jobId,
                issueNumber: issueRef.number,
                claudeSuccess: claudeResult.success,
                claudeResultStructure: {
                    success: claudeResult.success,
                    executionTime: claudeResult.executionTime,
                    modifiedFilesCount: claudeResult.modifiedFiles?.length || 0,
                    hasOutput: !!claudeResult.output,
                    exitCode: claudeResult.exitCode,
                    hasLogs: !!claudeResult.logs
                }
            }, 'EXECUTION DEBUG: Claude Code execution completed');

            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                claudeSuccess: claudeResult.success,
                executionTime: claudeResult.executionTime,
                modifiedFiles: claudeResult.modifiedFiles?.length || 0,
                claudeOutputSample: claudeResult.output?.rawOutput?.substring(0, 500),
                claudeFullOutput: claudeResult.output,
                claudeExitCode: claudeResult.exitCode,
                claudeLogs: claudeResult.logs
            }, 'Claude Code execution completed - detailed output');
            
            try {
                const fs = await import('fs');
                const path = await import('path');
                
                const listFiles = (dir) => {
                    const files = [];
                    const items = fs.readdirSync(dir);
                    for (const item of items) {
                        const fullPath = path.join(dir, item);
                        const stat = fs.statSync(fullPath);
                        if (stat.isDirectory() && !item.startsWith('.')) {
                            files.push(...listFiles(fullPath));
                        } else if (stat.isFile()) {
                            files.push(fullPath);
                        }
                    }
                    return files;
                };
                
                const filesInWorktree = listFiles(worktreeInfo.worktreePath);
                
                logger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    worktreePath: worktreeInfo.worktreePath,
                    filesInWorktree,
                    fileCount: filesInWorktree.length
                }, 'Files in worktree after Claude execution');
                
            } catch (listError) {
                logger.warn({
                    jobId,
                    issueNumber: issueRef.number,
                    error: listError.message
                }, 'Failed to list files in worktree');
            }
            
            logger.info({ 
                jobId, 
                issueNumber: issueRef.number,
                worktreePath: worktreeInfo.worktreePath,
                claudeSuccess: claudeResult?.success
            }, 'Starting deterministic post-processing...');

            try {
                let commitMessage = `fix(ai): Resolve issue #${issueRef.number} - ${currentIssueData.data.title.substring(0, 50)}

Implemented by Claude Code using ${modelName} model.

${claudeResult?.success ? 'Implementation completed successfully.' : 'Implementation attempted - see PR comments for details.'}`;
                
                if (claudeResult?.suggestedCommitMessage) {
                    commitMessage = claudeResult.suggestedCommitMessage;
                }

                commitResult = await commitChanges(
                    worktreeInfo.worktreePath,
                    commitMessage,
                    {
                        name: 'Claude Code',
                        email: 'claude-code@anthropic.com'
                    },
                    issueRef.number,
                    currentIssueData.data.title
                );

                logger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    branchName: worktreeInfo.branchName,
                    hasCommits: !!commitResult
                }, 'Pushing changes and creating PR...');

                await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    repoUrl,
                    authToken: githubToken.token
                });
                
                logger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    branchName: worktreeInfo.branchName
                }, 'Branch pushed to remote successfully');

                let prTitle = `AI Analysis for Issue #${issueRef.number}: ${currentIssueData.data.title}`;
                if (commitResult) {
                    prTitle = `AI Fix for Issue #${issueRef.number}: ${currentIssueData.data.title}`;
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
                        base: repoValidation.repoData.defaultBranch,
                        body: prBody,
                        draft: false
                    });

                    logger.info({
                        jobId,
                        issueNumber: issueRef.number,
                        prNumber: prResponse.data.number,
                        prUrl: prResponse.data.html_url
                    }, 'PR created successfully');

                    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: prResponse.data.number,
                        labels: [PR_LABEL]
                    });

                    postProcessingResult = {
                        success: true,
                        pr: {
                            number: prResponse.data.number,
                            url: prResponse.data.html_url,
                            title: prResponse.data.title
                        },
                        updatedLabels: []
                    };

                    logger.info({
                        jobId,
                        issueNumber: issueRef.number,
                        prNumber: prResponse.data.number,
                        linkedViaKeyword: commitResult ? 'Closes' : 'Addresses'
                    }, 'PR linked to issue via GitHub keyword in description');

                } catch (prError) {
                    logger.warn({
                        jobId,
                        issueNumber: issueRef.number,
                        branchName: worktreeInfo.branchName,
                        error: prError.message
                    }, 'Direct PR creation failed, checking if PR already exists...');

                    try {
                        const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                            owner: issueRef.repoOwner,
                            repo: issueRef.repoName,
                            head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`,
                            state: 'open'
                        });

                        if (existingPRs.data.length > 0) {
                            const existingPR = existingPRs.data[0];
                            logger.info({
                                jobId,
                                issueNumber: issueRef.number,
                                prNumber: existingPR.number,
                                prUrl: existingPR.html_url
                            }, 'Found existing PR for branch');

                            postProcessingResult = {
                                success: true,
                                pr: {
                                    number: existingPR.number,
                                    url: existingPR.html_url,
                                    title: existingPR.title
                                },
                                updatedLabels: []
                            };

                            logger.info({
                                jobId,
                                issueNumber: issueRef.number,
                                prNumber: existingPR.number
                            }, 'Found existing PR (linking depends on PR description keywords)');
                        } else {
                            throw prError;
                        }
                    } catch (checkError) {
                        throw prError;
                    }
                }

                await safeUpdateLabels(
                    octokit, 
                    issueRef.repoOwner, 
                    issueRef.repoName, 
                    issueRef.number,
                    [AI_PROCESSING_TAG],
                    [AI_DONE_TAG],
                    correlatedLogger
                );

                logger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    prNumber: postProcessingResult.pr?.number,
                    prUrl: postProcessingResult.pr?.url
                }, 'Deterministic post-processing completed successfully');

            } catch (postProcessingError) {
                logger.error({
                    jobId,
                    issueNumber: issueRef.number,
                    error: postProcessingError.message,
                    stack: postProcessingError.stack
                }, 'Deterministic post-processing failed');

                try {
                    await safeUpdateLabels(
                        octokit, 
                        issueRef.repoOwner, 
                        issueRef.repoName, 
                        issueRef.number,
                        [AI_PROCESSING_TAG],
                        [AI_DONE_TAG],
                        correlatedLogger
                    );

                    const completionComment = await generateCompletionComment(claudeResult, issueRef);
                    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: issueRef.number,
                        body: `⚠️ **Post-processing encountered an error, but Claude analysis was completed.**\n\n${completionComment}`,
                    });

                    postProcessingResult = {
                        success: false,
                        pr: null,
                        updatedLabels: [AI_DONE_TAG],
                        error: postProcessingError.message
                    };
                } catch (fallbackError) {
                    logger.error({
                        jobId,
                        issueNumber: issueRef.number,
                        error: fallbackError.message
                    }, 'Fallback post-processing also failed');
                    
                    postProcessingResult = {
                        success: false,
                        pr: null,
                        updatedLabels: [],
                        error: postProcessingError.message
                    };
                }
            }
            
            await job.updateProgress(95);
            
        } finally {
            correlatedLogger.info({
                jobId,
                issueNumber: issueRef.number,
                workerFinally: 'ENTERED_FINALLY_BLOCK'
            }, 'WORKER DEBUG: Entered finally block - this should ALWAYS appear');

            correlatedLogger.info({
                jobId,
                issueNumber: issueRef.number,
                claudeResultExists: !!claudeResult,
                claudeSuccess: claudeResult?.success,
                claudeResultType: typeof claudeResult,
                claudeResultKeys: claudeResult ? Object.keys(claudeResult) : null,
                worktreeInfoExists: !!worktreeInfo,
                worktreeInfoType: typeof worktreeInfo,
                branchName: worktreeInfo?.branchName,
                worktreePath: worktreeInfo?.worktreePath,
                worktreeInfoKeys: worktreeInfo ? Object.keys(worktreeInfo) : null,
                postProcessingSuccess: !!postProcessingResult?.pr,
                postProcessingResultExists: !!postProcessingResult,
                postProcessingResultType: typeof postProcessingResult,
                postProcessingResultKeys: postProcessingResult ? Object.keys(postProcessingResult) : null
            }, 'VALIDATION DEBUG: Complete variable state check for final PR validation');

            if (claudeResult?.success && worktreeInfo?.branchName) {
                correlatedLogger.info({
                    jobId,
                    issueNumber: issueRef.number,
                    branchName: worktreeInfo.branchName,
                    postProcessingSuccess: !!postProcessingResult?.pr
                }, 'CRITICAL: Performing final PR validation after Claude execution');

                try {
                    const finalPRValidation = await validatePRCreation({
                        owner: issueRef.repoOwner,
                        repoName: issueRef.repoName,
                        branchName: worktreeInfo.branchName,
                        expectedPrNumber: postProcessingResult?.pr?.number,
                        correlationId
                    });

                    correlatedLogger.info({
                        jobId,
                        issueNumber: issueRef.number,
                        validationResult: finalPRValidation
                    }, 'VALIDATION COMPLETED: Final PR validation result');

                    if (finalPRValidation.isValid && !postProcessingResult?.pr) {
                        correlatedLogger.info({
                            jobId,
                            issueNumber: issueRef.number,
                            prNumber: finalPRValidation.pr.number,
                            prUrl: finalPRValidation.pr.url
                        }, 'Found PR that post-processing missed - updating results and labels');

                        postProcessingResult = { 
                            pr: finalPRValidation.pr, 
                            updatedLabels: postProcessingResult?.updatedLabels || [] 
                        };

                        await safeUpdateLabels(
                            octokit, 
                            issueRef.repoOwner, 
                            issueRef.repoName, 
                            issueRef.number,
                            [AI_PROCESSING_TAG], 
                            [AI_DONE_TAG], 
                            correlatedLogger
                        );

                    } else if (!finalPRValidation.isValid && claudeResult?.success) {
                        correlatedLogger.warn({
                            jobId,
                            issueNumber: issueRef.number,
                            branchName: worktreeInfo.branchName,
                            validationError: finalPRValidation.error
                        }, 'Claude succeeded but no PR found - triggering emergency retry');

                        const repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
                    
                        if (repoValidation.isValid) {
                            const emergencyPrompt = `The code changes for GitHub issue #${issueRef.number} have already been implemented and committed to branch ${worktreeInfo.branchName}.

**URGENT TASK: CREATE PULL REQUEST**

**REPOSITORY INFORMATION (USE EXACTLY):**
- Repository: ${issueRef.repoOwner}/${issueRef.repoName}
- Branch: ${worktreeInfo.branchName}
- Base Branch: ${repoValidation.repoData.defaultBranch}
- Issue: #${issueRef.number}

**CRITICAL INSTRUCTIONS:**
1. You are in directory: ${worktreeInfo.worktreePath}
2. The code changes are already committed
3. Your ONLY task is to create a pull request
4. Use: \`gh pr create --title "Fix issue #${issueRef.number}" --body "Resolves #${issueRef.number}"\`
5. DO NOT make any code changes
6. DO NOT commit anything
7. ONLY create the pull request

**VERIFICATION:**
After creating the PR, verify it exists with: \`gh pr list\`

This is an emergency retry - the main implementation is complete, you just need to create the PR.`;

                            const emergencyRetry = await executeClaudeCode({
                                worktreePath: worktreeInfo.worktreePath,
                                issueRef: issueRef,
                                githubToken: githubToken.token,
                                customPrompt: emergencyPrompt,
                                isRetry: true,
                                retryReason: 'Emergency PR creation - main implementation complete',
                                branchName: worktreeInfo.branchName,
                                modelName: modelName
                            });

                            correlatedLogger.info({
                                jobId,
                                issueNumber: issueRef.number,
                                emergencyRetrySuccess: emergencyRetry.success
                            }, 'Emergency PR creation retry completed');

                            if (emergencyRetry.success) {
                                const emergencyValidation = await validatePRCreation({
                                    owner: issueRef.repoOwner,
                                    repoName: issueRef.repoName,
                                    branchName: worktreeInfo.branchName,
                                expectedPrNumber: null,
                                correlationId
                            });

                                if (emergencyValidation.isValid) {
                                    correlatedLogger.info({
                                        jobId,
                                        issueNumber: issueRef.number,
                                        prNumber: emergencyValidation.pr.number,
                                        prUrl: emergencyValidation.pr.url
                                    }, 'Emergency PR creation successful');

                                    postProcessingResult = { 
                                        pr: emergencyValidation.pr, 
                                        updatedLabels: [] 
                                    };
                                }
                            }
                        }
                    }
                } catch (validationError) {
                    correlatedLogger.error({
                        jobId,
                        issueNumber: issueRef.number,
                        error: validationError.message,
                        stack: validationError.stack
                    }, 'CRITICAL ERROR: Final PR validation failed with exception');
                }
            } else {
                correlatedLogger.warn({
                    jobId,
                    issueNumber: issueRef.number,
                    claudeResultExists: !!claudeResult,
                    claudeSuccess: claudeResult?.success,
                    worktreeInfoExists: !!worktreeInfo,
                    branchName: worktreeInfo?.branchName
                }, 'VALIDATION SKIPPED: Conditions not met for final PR validation');
            }
            if (worktreeInfo) {
                try {
                    logger.info({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        worktreePath: worktreeInfo.worktreePath
                    }, 'Cleaning up Git worktree...');
                    
                    const wasSuccessful = claudeResult?.success && postProcessingResult?.pr;
                    
                    await cleanupWorktree(
                        localRepoPath, 
                        worktreeInfo.worktreePath, 
                        worktreeInfo.branchName,
                        {
                            deleteBranch: !wasSuccessful,
                            success: wasSuccessful,
                            retentionStrategy: process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete'
                        }
                    );
                } catch (cleanupError) {
                    logger.warn({ 
                        jobId, 
                        issueNumber: issueRef.number,
                        error: cleanupError.message
                    }, 'Failed to cleanup worktree');
                }
            }
        }

        await job.updateProgress(100);

        const finalStatus = claudeResult?.success ? 
            (postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes') : 
            'claude_processing_failed';

        const jobStartTime = Date.now();
        const timeToPR = postProcessingResult?.pr ? (Date.now() - jobStartTime) : null;
        
        correlatedLogger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            correlationId,
            taskId,
            
            status: finalStatus,
            resolution: claudeResult?.success ? 
                (postProcessingResult?.pr ? 'resolved' : 'no_changes_needed') : 'failed',
            
            timeToPRMs: timeToPR,
            timeToPRMinutes: timeToPR ? Math.round(timeToPR / 60000) : null,
            
            claudeSuccess: claudeResult?.success || false,
            claudeExecutionTimeMs: claudeResult?.executionTime || 0,
            claudeExecutionTimeMinutes: claudeResult?.executionTime ? 
                Math.round(claudeResult.executionTime / 60000) : 0,
            claudeNumTurns: claudeResult?.finalResult?.num_turns || null,
            claudeCostUsd: claudeResult?.finalResult?.cost_usd || null,
            claudeModel: claudeResult?.model || null,
            
            prCreated: !!postProcessingResult?.pr,
            prNumber: postProcessingResult?.pr?.number || null,
            prUrl: postProcessingResult?.pr?.url || null,
            modifiedFilesCount: claudeResult?.modifiedFiles?.length || 0,
            
            failureCategory: !claudeResult?.success ? 
                (claudeResult?.error?.includes('timeout') ? 'timeout' :
                 claudeResult?.error?.includes('API') ? 'api_error' :
                 claudeResult?.error?.includes('git') ? 'git_error' : 'claude_error') : null,
                 
            worktreeCreated: !!worktreeInfo,
            branchName: worktreeInfo?.branchName,
            
            timestamp: new Date().toISOString(),
            systemVersion: process.env.npm_package_version || 'unknown'
        }, 'Issue processing completed - comprehensive metrics logged');

        // Mark task as completed in state manager
        try {
            await stateManager.markTaskCompleted(taskId, {
                status: finalStatus,
                claudeSuccess: claudeResult?.success || false,
                prCreated: !!postProcessingResult?.pr,
                prNumber: postProcessingResult?.pr?.number || null,
                prUrl: postProcessingResult?.pr?.url || null,
                commitResult: commitResult ? {
                    commitHash: commitResult.commitHash,
                    commitMessage: commitResult.commitMessage
                } : null
            });
        } catch (stateError) {
            correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to completed');
        }

        return {
            status: finalStatus,
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            gitSetup: {
                localRepoPath: localRepoPath,
                worktreeCreated: !!worktreeInfo,
                branchName: worktreeInfo?.branchName
            },
            claudeResult: {
                success: claudeResult?.success || false,
                executionTime: claudeResult?.executionTime || 0,
                modifiedFiles: claudeResult?.modifiedFiles || [],
                conversationLog: claudeResult?.conversationLog || [],
                error: claudeResult?.error || null,
                sessionId: claudeResult?.sessionId || null,
                conversationId: claudeResult?.conversationId || null,
                model: claudeResult?.model || null
            },
            postProcessing: {
                success: !!postProcessingResult,
                pr: postProcessingResult?.pr || null,
                updatedLabels: postProcessingResult?.updatedLabels || []
            }
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            correlatedLogger.warn({
                jobId,
                issueNumber: issueRef.number,
                resetTimestamp: error.resetTimestamp
            }, 'Claude usage limit hit during issue processing. Requeueing job.');

            const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
            const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
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

        } else {
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
                    await recordLLMMetrics(claudeResult, issueRef, 'issue', correlationId, taskId);
                    correlatedLogger.info({
                        correlationId,
                        issueNumber: issueRef.number
                    }, 'LLM metrics recorded for failed job');
                } catch (metricsError) {
                    correlatedLogger.error({
                        error: metricsError.message,
                        correlationId
                    }, 'Failed to record LLM metrics for failed job');
                }
            }
            
            if (octokit) {
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
                        octokit,
                        issueRef.repoOwner,
                        issueRef.repoName,
                        issueRef.number,
                        AI_PROCESSING_TAG,
                        correlatedLogger
                    );
                    
                } catch (commentError) {
                    correlatedLogger.error({ 
                        error: commentError.message,
                        issueNumber: issueRef.number
                    }, 'Failed to post error comment to GitHub issue');
                }
            }
            
            try {
                await stateManager.markTaskFailed(taskId, error, { 
                    errorCategory,
                    processingStage: claudeResult ? 'post_processing' : 'pre_processing'
                });
            } catch (stateError) {
                correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to failed');
            }
            
            throw error;
        }
    }
}

/**
 * Handles the dispatching of matrix jobs based on issue labels.
 * This function is called for "original" jobs (isChildJob: false).
 */
async function handleDispatch(job) {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ jobId, issueRef: issueRef.number }, 'Running as matrix dispatcher...');

    let octokit;
    let currentIssueData;
    let repoValidation;

    try {
        // 1. Authenticate
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit_dispatcher'
        );

        // 2. Fetch Issue to read labels
        currentIssueData = await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
            }),
            { ...retryConfigs.githubApi, correlationId },
            `get_issue_${issueRef.number}_dispatcher`
        );

        // 3. Fetch Repo info for default branch
        repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
        if (!repoValidation.isValid) {
            throw new Error('Repository validation failed for dispatcher.');
        }

        // 4. Determine Matrix Axes
        const defaultBranch = repoValidation.repoData.defaultBranch;
        const defaultModel = DEFAULT_MODEL_NAME;
        const labels = currentIssueData.data.labels.map(l => l.name);

        const baseLabels = labels.filter(l => l.startsWith('base-'));
        const llmLabels = labels.filter(l => l.startsWith('llm-'));

        // If no 'base-*' labels, use default. Otherwise, use found labels.
        const basesToProcess = baseLabels.length > 0
            ? baseLabels.map(l => ({ branch: l.substring('base-'.length), label: l }))
            : [{ branch: defaultBranch, label: null }];

        // If no 'llm-*' labels, use default. Otherwise, use found labels.
        const modelsToProcess = llmLabels.length > 0
            ? llmLabels.map(l => ({ model: l.substring('llm-'.length), label: l }))
            : [{ model: defaultModel, label: null }];

        // 5. Create and Enqueue Child Jobs (Cartesian Product)
        let jobsEnqueued = 0;
        for (const base of basesToProcess) {
            for (const model of modelsToProcess) {
                const newJobData = {
                    ...issueRef,
                    baseBranch: base.branch,
                    baseLabel: base.label,
                    modelName: model.model,
                    modelLabel: model.label,
                    isChildJob: true,
                    issuePayload: currentIssueData.data,
                    repoPayload: repoValidation.repoData
                };

                await issueQueue.add(jobName, newJobData);
                jobsEnqueued++;
                correlatedLogger.info({ jobId, issue: issueRef.number, base: base.branch, model: model.model }, 'Enqueued child job');
            }
        }

        correlatedLogger.info({ jobId, issue: issueRef.number, jobsEnqueued }, 'Matrix dispatcher job complete.');

    } catch (error) {
        correlatedLogger.error({ 
            jobId, 
            issue: issueRef.number,
            errMessage: error.message, 
            stack: error.stack
        }, 'Error in matrix dispatcher, job will fail and not dispatch children');
        throw error;
    }
}

export { processGitHubIssueJob };
