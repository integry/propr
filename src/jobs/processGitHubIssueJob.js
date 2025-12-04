import logger, { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
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
import { addModelSpecificDelay } from '../utils/scheduling.js';
import { safeAddLabel, safeUpdateLabels } from '../utils/github/labelOperations.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { generateCompletionComment } from '../utils/github/logFiles.js';
import fs from 'fs-extra';
import { executeClaudeCode, UsageLimitError } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { validatePRCreation, validateRepositoryInfo } from '../utils/prValidation.js';
import Redis from 'ioredis';
import { getDefaultModel } from '../config/modelAliases.js';
import { loadPrLabel, loadPrimaryProcessingLabels } from '../config/configRepoManager.js';
import { filterCommentByAuthor } from '../utils/commentFilters.js';
import { handleDispatch } from './issueJobDispatcher.js';
import { 
    handleUsageLimitError, 
    handleGenericError, 
    updateTaskTitleInStorage,
    createPullRequest,
    buildFinalResult 
} from './issueJobHelpers.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

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

async function processGitHubIssueJob(job) {
    logger.debug({
        jobId: job.id,
        isChildJob: job.data.isChildJob,
        hasModelName: !!job.data.modelName
    }, 'Checking if job should be dispatched');

    if (!job.data.isChildJob) {
        logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
        return await handleDispatch(job);
    }

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
    
    const modelName = issueRef.modelName || DEFAULT_MODEL_NAME;
    await addModelSpecificDelay(modelName);
    
    const taskId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${modelName}`;
    
    try {
        await stateManager.createTaskState(taskId, issueRef, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: stateError.message }, 'Failed to create task state, continuing anyway');
    }
    
    correlatedLogger.info({ jobId, jobName, taskId, issueNumber: issueRef.number, repo: `${issueRef.repoOwner}/${issueRef.repoName}` }, 'Processing job started');

    let octokit;
    try {
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );
    } catch (authError) {
        const errorDetails = handleError(authError, 'Worker: Failed to get authenticated Octokit instance', { correlationId, issueRef });
        try {
            await stateManager.markTaskFailed(taskId, authError, { errorCategory: errorDetails.category });
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
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting issue processing' });
        
        const currentIssueData = issueRef.issuePayload ? { data: issueRef.issuePayload } :
            await withRetry(
                () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                }),
                { ...retryConfigs.githubApi, correlationId },
                `get_issue_${issueRef.number}`
            );

        const currentLabels = currentIssueData.data.labels.map(label => label.name);
        
        if (!currentLabels.includes(AI_PRIMARY_TAG)) {
            logger.warn({ jobId, issueNumber: issueRef.number }, `Issue no longer has primary tag '${AI_PRIMARY_TAG}'. Skipping.`);
            return { status: 'skipped', reason: 'Primary tag missing', issueNumber: issueRef.number };
        }

        if (currentLabels.includes(AI_DONE_TAG)) {
            logger.warn({ jobId, issueNumber: issueRef.number }, `Issue already has '${AI_DONE_TAG}' tag. Skipping.`);
            return { status: 'skipped', reason: 'Already done', issueNumber: issueRef.number };
        }

        if (!currentLabels.includes(AI_PROCESSING_TAG)) {
            await safeAddLabel({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, AI_PROCESSING_TAG);
        }

        issueRef.title = `New Issue: ${currentIssueData.data.title}`;
        issueRef.subtitle = `Preparing a PR for issue #${issueRef.number}`;
        await updateTaskTitleInStorage(taskId, issueRef, stateManager, correlatedLogger);

        await job.updateProgress(25);
        
        const repoValidation = issueRef.repoPayload ? { isValid: true, repoData: issueRef.repoPayload } :
            await validateRepositoryInfo(issueRef, octokit, correlationId);
        
        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl(issueRef);
        
        try {
            await ensureGitRepository(correlatedLogger);
            
            localRepoPath = await ensureRepoCloned(repoUrl, issueRef.repoOwner, issueRef.repoName, githubToken.token);
            await job.updateProgress(50);
            
            worktreeInfo = await createWorktreeForIssue(
                localRepoPath, issueRef.number, currentIssueData.data.title,
                issueRef.repoOwner, issueRef.repoName,
                { baseBranch: issueRef.baseBranch || null, octokit, modelName }
            );
            
            await job.updateProgress(75);
            
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                body: `🤖 AI processing has started for this issue using **${modelName}** model.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.\n\n**Processing Details:**\n- Model: \`${modelName}\`\n- Branch: \`${worktreeInfo.branchName}\`\n- Base Branch: \`${issueRef.baseBranch || repoValidation.repoData.defaultBranch}\`\n- Worktree: \`${worktreeInfo.worktreePath.split('/').pop()}\``,
            });
            
            await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
                repoUrl,
                authToken: githubToken.token,
                tokenRefreshFn: async () => (await octokit.auth()).token,
                correlationId
            });
            
            await job.updateProgress(80);
            
            let issueComments = [];
            try {
                const allComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: issueRef.number,
                    per_page: 100
                });
                
                issueComments = allComments.filter(comment => {
                    const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type, correlationId);
                    return !filterResult.shouldFilter;
                });
            } catch (commentError) {
                correlatedLogger.warn({ issueNumber: issueRef.number, error: commentError.message }, 'Failed to fetch issue comments, continuing without them');
            }

            claudeResult = await executeClaudeCode({
                worktreePath: worktreeInfo.worktreePath,
                issueRef,
                githubToken: githubToken.token,
                branchName: worktreeInfo.branchName,
                modelName,
                issueDetails: {
                    title: currentIssueData.data.title,
                    body: currentIssueData.data.body,
                    comments: issueComments,
                    labels: currentIssueData.data.labels,
                    created_at: currentIssueData.data.created_at,
                    updated_at: currentIssueData.data.updated_at,
                    user: currentIssueData.data.user
                },
                onSessionId: createSessionIdCallback(taskId, issueRef, modelName, stateManager, correlatedLogger),
                onContainerId: createContainerIdCallback(taskId, stateManager, correlatedLogger)
            });
            
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                reason: 'Claude execution completed',
                claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
                historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model }
            });
            
            await recordLLMMetrics(claudeResult, issueRef, 'issue', correlationId, taskId);

            const postProcessResult = await performPostProcessing({
                octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, 
                modelName, repoValidation, repoUrl, githubToken, PR_LABEL, 
                AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger
            });
            commitResult = postProcessResult.commitResult;
            postProcessingResult = postProcessResult.postProcessingResult;
            
            await job.updateProgress(95);
            
        } finally {
            await performFinalValidation({
                claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult,
                repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, 
                localRepoPath, jobId, correlationId, correlatedLogger
            });
        }

        await job.updateProgress(100);

        try {
            await stateManager.markTaskCompleted(taskId, {
                status: claudeResult?.success ? (postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes') : 'claude_processing_failed',
                claudeSuccess: claudeResult?.success || false,
                prCreated: !!postProcessingResult?.pr,
                prNumber: postProcessingResult?.pr?.number || null,
                prUrl: postProcessingResult?.pr?.url || null,
                commitResult: commitResult ? { commitHash: commitResult.commitHash, commitMessage: commitResult.commitMessage } : null
            });
        } catch (stateError) {
            correlatedLogger.warn({ error: stateError.message }, 'Failed to update task state to completed');
        }

        return buildFinalResult(issueRef, localRepoPath, worktreeInfo, claudeResult, postProcessingResult, commitResult);

    } catch (error) {
        if (error instanceof UsageLimitError) {
            await handleUsageLimitError(error, job, issueRef, octokit, correlatedLogger, stateManager, taskId);
        } else {
            await handleGenericError(error, job, issueRef, { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG });
            throw error;
        }
    }
}

function createSessionIdCallback(taskId, issueRef, modelName, stateManager, correlatedLogger) {
    return async (sessionId, conversationId) => {
        try {
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                reason: 'Claude execution started',
                claudeResult: { sessionId, conversationId },
                historyMetadata: { sessionId, conversationId, model: modelName }
            });
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDir = '/tmp/claude-logs';
            await fs.ensureDir(logDir);
            
            const filePrefix = `issue-${issueRef.number}-${timestamp}`;
            const conversationPath = `${logDir}/${filePrefix}-conversation.json`;
            
            await fs.writeFile(conversationPath, JSON.stringify({
                sessionId, conversationId, timestamp: new Date().toISOString(),
                issueNumber: issueRef.number, repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                messages: [], _streaming: true
            }, null, 2));
            
            const redis = new Redis({ host: process.env.REDIS_HOST || 'redis', port: process.env.REDIS_PORT || 6379 });
            const logData = {
                files: { conversation: conversationPath },
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                timestamp, sessionId, conversationId
            };
            
            if (sessionId) await redis.set(`execution:logs:session:${sessionId}`, JSON.stringify(logData), 'EX', 86400 * 30);
            if (conversationId) await redis.set(`execution:logs:conversation:${conversationId}`, JSON.stringify(logData), 'EX', 86400 * 30);
            await redis.quit();
        } catch (error) {
            correlatedLogger.warn({ error: error.message, taskId, sessionId }, 'Failed to update task state with early sessionId');
        }
    };
}

function createContainerIdCallback(taskId, stateManager, correlatedLogger) {
    return async (containerId, containerName) => {
        try {
            await stateManager.updateHistoryMetadata(taskId, 'claude_execution', { containerId, containerName });
        } catch (err) {
            correlatedLogger.warn({ taskId, error: err.message }, 'Failed to update state with container info');
        }
    };
}

async function performPostProcessing(options) {
    const { octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger } = options;
    let commitResult = null;
    let postProcessingResult = null;
    
    try {
        let commitMessage = `fix(ai): Resolve issue #${issueRef.number} - ${currentIssueData.data.title.substring(0, 50)}\n\nImplemented by Claude Code using ${modelName} model.\n\n${claudeResult?.success ? 'Implementation completed successfully.' : 'Implementation attempted - see PR comments for details.'}`;
        
        if (claudeResult?.suggestedCommitMessage) {
            commitMessage = claudeResult.suggestedCommitMessage;
        }

        commitResult = await commitChanges(
            worktreeInfo.worktreePath, commitMessage,
            { name: 'Claude Code', email: 'claude-code@anthropic.com' },
            issueRef.number, currentIssueData.data.title
        );

        await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token });

        postProcessingResult = await createPullRequest(
            octokit, issueRef, worktreeInfo, 
            { commitResult, claudeResult, modelName, repoValidation, PR_LABEL, correlatedLogger }
        );

        await safeUpdateLabels(
            { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
            [AI_PROCESSING_TAG], [AI_DONE_TAG]
        );

    } catch (postProcessingError) {
        correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: postProcessingError.message }, 'Deterministic post-processing failed');

        try {
            await safeUpdateLabels(octokit, issueRef.repoOwner, issueRef.repoName, issueRef.number, [AI_PROCESSING_TAG], [AI_DONE_TAG], correlatedLogger);
            const completionComment = await generateCompletionComment(claudeResult, issueRef);
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
                body: `⚠️ **Post-processing encountered an error, but Claude analysis was completed.**\n\n${completionComment}`,
            });
            postProcessingResult = { success: false, pr: null, updatedLabels: [AI_DONE_TAG], error: postProcessingError.message };
        } catch (fallbackError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: fallbackError.message }, 'Fallback post-processing also failed');
            postProcessingResult = { success: false, pr: null, updatedLabels: [], error: postProcessingError.message };
        }
    }
    
    return { commitResult, postProcessingResult };
}

async function performFinalValidation(options) {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath, jobId, correlationId, correlatedLogger } = options;
    let resolvedPostProcessingResult = postProcessingResult;
    if (claudeResult?.success && worktreeInfo?.branchName) {
        try {
            const finalPRValidation = await validatePRCreation({
                owner: issueRef.repoOwner, repoName: issueRef.repoName,
                branchName: worktreeInfo.branchName, expectedPrNumber: postProcessingResult?.pr?.number, correlationId
            });

            if (finalPRValidation.isValid && !postProcessingResult?.pr) {
                resolvedPostProcessingResult = { pr: finalPRValidation.pr, updatedLabels: postProcessingResult?.updatedLabels || [] };
                await safeUpdateLabels(octokit, issueRef.repoOwner, issueRef.repoName, issueRef.number, [AI_PROCESSING_TAG], [AI_DONE_TAG], correlatedLogger);
            } else if (!finalPRValidation.isValid && claudeResult?.success) {
                await attemptEmergencyPRCreation({ worktreeInfo, issueRef, repoValidation, githubToken, modelName, correlationId, correlatedLogger });
            }
        } catch (validationError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: validationError.message }, 'Final PR validation failed');
        }
    }
    
    if (worktreeInfo) {
        try {
            const wasSuccessful = claudeResult?.success && resolvedPostProcessingResult?.pr;
            await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                deleteBranch: !wasSuccessful, success: wasSuccessful,
                retentionStrategy: process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete'
            });
        } catch (cleanupError) {
            correlatedLogger.warn({ jobId, issueNumber: issueRef.number, error: cleanupError.message }, 'Failed to cleanup worktree');
        }
    }
}

async function attemptEmergencyPRCreation(options) {
    const { worktreeInfo, issueRef, repoValidation, githubToken, modelName, correlationId, correlatedLogger } = options;
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
7. ONLY create the pull request`;

    const emergencyRetry = await executeClaudeCode({
        worktreePath: worktreeInfo.worktreePath,
        issueRef, githubToken: githubToken.token,
        customPrompt: emergencyPrompt, isRetry: true,
        retryReason: 'Emergency PR creation - main implementation complete',
        branchName: worktreeInfo.branchName, modelName
    });

    if (emergencyRetry.success) {
        const emergencyValidation = await validatePRCreation({
            owner: issueRef.repoOwner, repoName: issueRef.repoName,
            branchName: worktreeInfo.branchName, expectedPrNumber: null, correlationId
        });
        
        if (emergencyValidation.isValid) {
            correlatedLogger.info({ issueNumber: issueRef.number, prNumber: emergencyValidation.pr.number }, 'Emergency PR creation successful');
        }
    }
}

export { processGitHubIssueJob };
