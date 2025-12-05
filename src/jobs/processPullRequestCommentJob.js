import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { ensureRepoCloned, createWorktreeFromExistingBranch, cleanupWorktree, getRepoUrl, commitChanges, pushBranch } from '../git/repoManager.js';
import { formatResetTime } from '../utils/scheduling.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { createLogFiles } from '../utils/github/logFiles.js';
import { executeClaudeCode, UsageLimitError, generateTaskSummary } from '../claude/claudeService.js';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue } from '../queue/taskQueue.js';
import Redis from 'ioredis';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { loadPrLabel } from '../config/configRepoManager.js';
import { getPendingPrCommentsKey } from '../utils/constants.js';
import {
    validateAndFilterComments,
    filterUnprocessedComments,
    fetchLinkedIssueContext,
    buildCommentHistory,
    createSessionIdCallbackForPR,
    createContainerIdCallbackForPR,
    updateTaskTitleForPR,
    buildCompletionComment
} from './prCommentJobHelpers.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10);
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

async function getPrLabel() {
    try {
        if (process.env.CONFIG_REPO) return await loadPrLabel();
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load PR label from config, using fallback');
    }
    return process.env.PR_LABEL || 'gitfix';
}

async function initializePRJobContext(job) {
    const { pullRequestNumber, commentId, commentBody, commentAuthor, comments, branchName: jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const PR_LABEL = await getPrLabel();
    const isBatchJob = !!comments && Array.isArray(comments);
    let commentsToProcess = isBatchJob ? [...comments] : [{ id: commentId, body: commentBody, author: commentAuthor }];
    commentsToProcess = await pickUpPendingComments(commentsToProcess, repoOwner, repoName, { pullRequestNumber, correlatedLogger });
    
    return { pullRequestNumber, jobBranchName, repoOwner, repoName, llm: jobLlm, correlationId, correlatedLogger, PR_LABEL, isBatchJob, commentsToProcess };
}

async function acquirePRLock(stateManager, lockKey, correlationId, correlatedLogger, job) {
    const currentLock = await stateManager.redis.get(lockKey);
    if (currentLock && currentLock !== correlationId) {
        correlatedLogger.info({ lockOwner: currentLock }, 'PR is currently being processed by another job. Rescheduling...');
        await issueQueue.add(job.name, job.data, { delay: 10000 });
        return false;
    }
    await stateManager.redis.set(lockKey, correlationId, 'EX', 3600);
    return true;
}

async function validatePRAndComments(octokit, context) {
    const { commentsToProcess, pullRequestNumber, repoOwner, repoName, PR_LABEL, correlatedLogger, llm: initialLlm } = context;
    
    const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: repoOwner, repo: repoName, pull_number: pullRequestNumber });
    const botUsername = process.env.GITHUB_BOT_USERNAME || 'gitfixio[bot]';
    const prCommentsForValidation = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, per_page: 100 });
    const reviewCommentsForValidation = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', { owner: repoOwner, repo: repoName, pull_number: pullRequestNumber, per_page: 100 });
    const allCommentsForValidation = [...prCommentsForValidation, ...reviewCommentsForValidation];
    const validatedComments = await validateAndFilterComments(commentsToProcess, allCommentsForValidation, pullRequestNumber, correlatedLogger);
    
    if (validatedComments.length === 0) return { skip: true, reason: 'all_comments_deleted' };
    if (!prData.data.labels.some(label => label.name === PR_LABEL)) return { skip: true, reason: 'missing_required_label' };
    
    const llm = extractModelFromLabels(prData.data.labels, initialLlm, pullRequestNumber, correlatedLogger);
    const unprocessedComments = filterUnprocessedComments(validatedComments, prCommentsForValidation, botUsername, { pullRequestNumber, correlatedLogger });
    if (unprocessedComments.length === 0) return { skip: true, reason: 'already_processed' };
    
    return { skip: false, prData, validatedComments, unprocessedComments, llm, prCommentsForValidation };
}

async function executeAndCommit(context) {
    const { octokit, worktreeInfo, githubToken, repoUrl, prompt, llm, taskId, stateManager, correlatedLogger, job, pullRequestNumber, repoOwner, repoName, correlationId, unprocessedComments, authorsText, startingWorkComment } = context;
    
    const claudeResult = await executeClaudeCode({
        worktreePath: worktreeInfo.worktreePath,
        issueRef: { number: pullRequestNumber, repoOwner, repoName, title: job.data.title },
        githubToken: githubToken.token, customPrompt: prompt, branchName: worktreeInfo.branchName,
        modelName: llm || DEFAULT_MODEL_NAME,
        onSessionId: createSessionIdCallbackForPR(taskId, { pullRequestNumber, repoOwner, repoName }, { llm: llm || DEFAULT_MODEL_NAME, stateManager, correlatedLogger }),
        onContainerId: createContainerIdCallbackForPR(taskId, stateManager)
    });

    await recordLLMMetrics(claudeResult, { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
    await createLogFiles(claudeResult, { number: pullRequestNumber, repoOwner, repoName });
    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: 'Claude execution completed',
        claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
        historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model }
    });

    if (!claudeResult.success) throw new Error(`Claude execution failed: ${claudeResult.error || 'Unknown error'}`);

    const changesSummary = claudeResult.summary || claudeResult.finalResult?.result || '';
    const commitMessage = buildCommitMessage({ changesSummary, unprocessedComments, pullRequestNumber, claudeResult, llm, authorsText });
    const commitResult = await commitChanges(worktreeInfo.worktreePath, commitMessage, { name: 'Claude Code', email: 'claude-code@anthropic.com' }, { issueNumber: pullRequestNumber, issueTitle: 'Follow-up changes' });

    return { claudeResult, commitResult, changesSummary, commitMessage };
}

async function postCompletionComment(context) {
    const { octokit, commitResult, worktreeInfo, repoUrl, githubToken, correlationId, repoOwner, repoName, startingWorkComment, unprocessedComments, changesSummary, commitMessage, llm, authorsText, claudeResult, correlatedLogger, pullRequestNumber } = context;
    
    if (commitResult) {
        await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, {
            repoUrl, authToken: githubToken.token, tokenRefreshFn: async () => (await octokit.auth()).token, correlationId
        });
        const prCommentBody = buildCompletionComment(commitResult, unprocessedComments, { changesSummary, commitMessage, llm, authorsText }, claudeResult);
        const completionComment = await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner: repoOwner, repo: repoName, comment_id: startingWorkComment.data.id, body: prCommentBody });
        correlatedLogger.info({ pullRequestNumber, commitHash: commitResult.commitHash, commentUrl: completionComment.data.html_url }, 'Successfully applied follow-up changes');
        return completionComment;
    }
    
    const noChangesBody = buildCompletionComment(null, unprocessedComments, { changesSummary, commitMessage, llm, authorsText }, claudeResult);
    return await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner: repoOwner, repo: repoName, comment_id: startingWorkComment.data.id, body: noChangesBody });
}

export async function processPullRequestCommentJob(job) {
    const context = await initializePRJobContext(job);
    const { pullRequestNumber, jobBranchName, repoOwner, repoName, correlationId, correlatedLogger, PR_LABEL, isBatchJob, commentsToProcess } = context;
    let { llm } = context;

    correlatedLogger.info({ pullRequestNumber, branchName: jobBranchName, llm, isBatchJob, commentsCount: commentsToProcess.length }, `Processing PR comment${isBatchJob ? 's batch' : ''} job...`);

    const taskId = job.id;
    const stateManager = getStateManager();
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;
    
    const lockAcquired = await acquirePRLock(stateManager, lockKey, correlationId, correlatedLogger, job);
    if (!lockAcquired) return { status: 'rescheduled', reason: 'pr_locked_by_other_job' };
    
    try {
        await stateManager.createTaskState(taskId, { number: pullRequestNumber, repoOwner, repoName, comments: job.data.comments }, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: stateError.message }, 'Failed to create initial task state, continuing anyway');
    }

    let octokit, localRepoPath, worktreeInfo, claudeResult = null, authorsText = '', unprocessedComments = [], startingWorkComment = null;

    try {
        octokit = await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');

        const validation = await validatePRAndComments(octokit, { ...context, llm });
        if (validation.skip) {
            correlatedLogger.info({ pullRequestNumber, reason: validation.reason }, 'Skipping PR comment processing');
            return { status: 'skipped', reason: validation.reason, pullRequestNumber };
        }
        
        const { prData, unprocessedComments: validUnprocessed, llm: resolvedLlm } = validation;
        unprocessedComments = validUnprocessed;
        llm = resolvedLlm;
        const branchName = jobBranchName || prData.data.head.ref;

        const { combinedCommentBody, commentAuthors } = buildCombinedComment(unprocessedComments);
        authorsText = commentAuthors.map(a => `@${a}`).join(', ');

        const allComments = await fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber);
        const commentsByTime = allComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        const originalTaskSpec = await fetchLinkedIssueContext(octokit, prData, { repoOwner, repoName, pullRequestNumber }, { correlationId, correlatedLogger });
        const commentHistory = buildCommentHistory(commentsByTime, prData, correlationId);
        
        startingWorkComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: `🔄 **Starting work on follow-up changes** requested by ${authorsText}\n\nI'll analyze the ${unprocessedComments.length} request${unprocessedComments.length > 1 ? 's' : ''} and implement the necessary changes.\n\n---\n_Processing comment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}_`,
        });

        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting PR comment processing' });
        await ensureGitRepository(correlatedLogger);
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, branchName, { worktreeDirName: `pr-${pullRequestNumber}-followup-${timestamp}`, owner: repoOwner, repoName });
        correlatedLogger.info({ worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName }, 'Created worktree from existing PR branch');

        const summaryTitle = await generateSummaryTitle({ combinedCommentBody, worktreeInfo, githubToken, pullRequestNumber, repoOwner, repoName, correlationId, taskId, correlatedLogger });
        job.data.title = `Followup: ${prData.data.title}`;
        job.data.subtitle = summaryTitle;
        await updateTaskTitleForPR(taskId, job.data, stateManager, correlatedLogger);

        const prompt = buildPrompt({ pullRequestNumber, combinedCommentBody, commentHistory, originalTaskSpec, worktreeInfo, repoOwner, repoName, commentCount: unprocessedComments.length });

        const execResult = await executeAndCommit({ octokit, worktreeInfo, githubToken, repoUrl, prompt, llm, taskId, stateManager, correlatedLogger, job, pullRequestNumber, repoOwner, repoName, correlationId, unprocessedComments, authorsText, startingWorkComment });
        claudeResult = execResult.claudeResult;
        const { commitResult, changesSummary, commitMessage } = execResult;

        const completionComment = await postCompletionComment({ octokit, commitResult, worktreeInfo, repoUrl, githubToken, correlationId, repoOwner, repoName, startingWorkComment, unprocessedComments, changesSummary, commitMessage, llm, authorsText, claudeResult, correlatedLogger, pullRequestNumber });

        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: 'PR comment processing completed successfully', commitHash: commitResult?.commitHash,
            historyMetadata: { githubComment: { url: completionComment.data.html_url, body: completionComment.data.body } }
        });

        return { status: 'complete', commit: commitResult?.commitHash, pullRequestNumber, claudeResult };

    } catch (error) {
        await handleJobError(error, job, { pullRequestNumber, repoOwner, repoName, authorsText, unprocessedComments, octokit, startingWorkComment, claudeResult, correlationId, correlatedLogger, stateManager, taskId });
        if (!(error instanceof UsageLimitError)) throw error;
    } finally {
        await cleanupJob({ stateManager, lockKey, correlationId, localRepoPath, worktreeInfo, repoOwner, repoName, pullRequestNumber, jobBranchName, jobLlm: context.llm, correlatedLogger });
    }
}

function parsePendingComment(commentJson, correlatedLogger) {
    try {
        return JSON.parse(commentJson);
    } catch (parseError) {
        correlatedLogger.warn({ error: parseError.message }, 'Failed to parse pending comment');
        return null;
    }
}

function processPendingComments(commentsToProcess, pendingComments, correlatedLogger) {
    for (const commentJson of pendingComments) {
        const pendingComment = parsePendingComment(commentJson, correlatedLogger);
        if (pendingComment && !commentsToProcess.some(c => c.id === pendingComment.id)) {
            commentsToProcess.push(pendingComment);
        }
    }
}

async function pickUpPendingComments(commentsToProcess, repoOwner, repoName, options = {}) {
    const { pullRequestNumber, correlatedLogger } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    try {
        const pendingComments = await redisClient.lrange(pendingCommentsKey, 0, -1);
        if (pendingComments.length > 0) {
            await redisClient.del(pendingCommentsKey);
            processPendingComments(commentsToProcess, pendingComments, correlatedLogger);
            correlatedLogger.info({ pullRequestNumber, pendingCount: pendingComments.length, totalCount: commentsToProcess.length }, 'Picked up pending comments from Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ error: redisError.message }, 'Failed to fetch pending comments from Redis');
    }
    return commentsToProcess;
}

function extractModelFromLabels(labels, currentLlm, pullRequestNumber, correlatedLogger) {
    if (labels && Array.isArray(labels)) {
        const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
        for (const label of labels) {
            const labelName = typeof label === 'string' ? label : label.name;
            const match = labelName.match(modelLabelRegex);
            if (match) {
                const resolvedModel = resolveModelAlias(match[1]);
                correlatedLogger.info({ pullRequestNumber, label: labelName, resolvedModel }, 'Using model from PR label');
                return resolvedModel;
            }
        }
    }
    return currentLlm;
}

function buildCombinedComment(unprocessedComments) {
    let combinedCommentBody;
    let commentAuthors = [];
    
    if (unprocessedComments.length === 1) {
        combinedCommentBody = unprocessedComments[0].body;
        commentAuthors = [unprocessedComments[0].author];
    } else {
        combinedCommentBody = unprocessedComments.map((comment, index) => `**Comment ${index + 1}** (by @${comment.author}):\n${comment.body}`).join('\n\n---\n\n');
        commentAuthors = [...new Set(unprocessedComments.map(c => c.author))];
    }
    return { combinedCommentBody, commentAuthors };
}

async function fetchAllComments(octokit, repoOwner, repoName, pullRequestNumber) {
    const issueComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, per_page: 100 });
    const reviewComments = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', { owner: repoOwner, repo: repoName, pull_number: pullRequestNumber, per_page: 100 });
    return [...issueComments, ...reviewComments];
}

async function generateSummaryTitle(options) {
    const { combinedCommentBody, worktreeInfo, githubToken, pullRequestNumber, repoOwner, repoName, correlationId, taskId, correlatedLogger } = options;
    try {
        const summaryRequest = `Summarize this change request in one sentence, focusing on the main action: ${combinedCommentBody}`;
        const title = await generateTaskSummary({ summaryRequest, worktreePath: worktreeInfo.worktreePath, githubToken: githubToken.token, issueRef: { number: pullRequestNumber, repoOwner, repoName }, correlationId, modelAlias: 'haiku' });
        correlatedLogger.info({ taskId, summaryTitle: title }, 'Generated AI summary for follow-up task');
        return title;
    } catch (summaryError) {
        correlatedLogger.warn({ taskId, error: summaryError.message }, 'Failed to generate AI summary, falling back to truncation.');
        if (combinedCommentBody) {
            const firstLine = combinedCommentBody.split('\n')[0].replace(/[^a-zA-Z0-9 ]/g, '').trim();
            return "Follow-up: " + firstLine.substring(0, 75) + (firstLine.length > 75 ? '...' : '');
        }
        return `Follow-up: PR #${pullRequestNumber}`;
    }
}

function buildPrompt(options) {
    const { pullRequestNumber, combinedCommentBody, commentHistory, originalTaskSpec, worktreeInfo, repoOwner, repoName, commentCount } = options;
    return `You are working on pull request #${pullRequestNumber} to apply follow-up changes.

**New Request${commentCount > 1 ? 's' : ''}:**
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
}

function buildCommitMessage(options) {
    const { changesSummary, unprocessedComments, pullRequestNumber, claudeResult, llm, authorsText } = options;
    let commitDetails = '';
    if (changesSummary) {
        const lines = changesSummary.split('\n');
        const changeLines = lines.filter(line => line.trim().startsWith('-') || line.trim().startsWith('*') || line.trim().startsWith('•') || line.match(/^\d+\./)).slice(0, 10);
        if (changeLines.length > 0) {
            commitDetails = '\n\nKey changes:\n' + changeLines.join('\n');
        }
    }

    const commentReferences = unprocessedComments.map(c => `Comment by: @${c.author} (ID: ${c.id})`).join('\n');
    
    return `feat(ai): ${changesSummary ? changesSummary.split('\n')[0] : 'Apply follow-up changes from PR comment'}

${changesSummary ? changesSummary : `Implemented changes requested by ${authorsText}`}${commitDetails}

PR: #${pullRequestNumber}
${commentReferences}
Model: ${claudeResult.model || llm || DEFAULT_MODEL_NAME}`;
}

async function handleJobError(error, job, options) {
    const { pullRequestNumber, repoOwner, repoName, authorsText, unprocessedComments, octokit, startingWorkComment, claudeResult, correlationId, correlatedLogger, stateManager, taskId } = options;
    if (error instanceof UsageLimitError) {
        correlatedLogger.warn({ pullRequestNumber, resetTimestamp: error.resetTimestamp }, 'Claude usage limit hit during PR comment processing. Requeueing job.');

        const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
        const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
        const readableResetTime = formatResetTime(error.resetTimestamp);

        if (octokit) {
            try {
                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
                    body: `⌛ **Processing Delayed:** Claude's usage limit was reached while processing requests from ${authorsText}.\n\nThe job has been automatically rescheduled and will restart ${readableResetTime}.\n\n---\n*Job ID: ${job.id} will run again after delay.*`
                });
            } catch (commentError) {
                correlatedLogger.error({ error: commentError.message }, 'Failed to post usage limit delay comment to PR.');
            }
        }

        await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
    } else {
        handleError(error, 'Failed to process PR comment job', { correlationId });
        
        await stateManager.updateTaskState(taskId, TaskStates.FAILED, { reason: 'PR comment processing failed', error: error.message });
        
        if (claudeResult) {
            try {
                await recordLLMMetrics(claudeResult, { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'pr_comment', correlationId, taskId });
            } catch (metricsError) {
                correlatedLogger.error({ error: metricsError.message, correlationId }, 'Failed to record LLM metrics for failed PR comment job');
            }
        }
        
        if (octokit && startingWorkComment) {
            try {
                await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                    owner: repoOwner, repo: repoName, comment_id: startingWorkComment.data.id,
                    body: `❌ **Failed to apply follow-up changes** requested by ${authorsText}\n\nAn error occurred while processing your request:\n\n\`\`\`\n${error.message}\n\`\`\`\n\n---\nComment ID${unprocessedComments.length > 1 ? 's' : ''}: ${unprocessedComments.map(c => String(c.id) + '✓').join(', ')}\nPlease check the logs for more details.`,
                });
            } catch (commentError) {
                correlatedLogger.error({ error: commentError.message }, 'Failed to post error comment');
            }
        }
    }
}

async function cleanupJob(options) {
    const { stateManager, lockKey, correlationId, localRepoPath, worktreeInfo, repoOwner, repoName, pullRequestNumber, jobBranchName, jobLlm, correlatedLogger } = options;
    const lockOwner = await stateManager.redis.get(lockKey);
    if (lockOwner === correlationId) {
        await stateManager.redis.del(lockKey);
        correlatedLogger.debug('Released PR processing lock');
    }

    if (localRepoPath && worktreeInfo) {
        try {
            await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, { deleteBranch: false, success: true });
        } catch (cleanupError) {
            correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
        }
    }

    try {
        const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
        const remainingPendingComments = await redisClient.llen(pendingCommentsKey);
        if (remainingPendingComments > 0) {
            correlatedLogger.info({ pullRequestNumber, pendingCount: remainingPendingComments }, 'Found pending comments that arrived during processing, queuing follow-up job');

            const followUpJobId = `pr-comments-batch-${repoOwner}-${repoName}-${pullRequestNumber}-${Date.now()}`;
            await issueQueue.add('processPullRequestComment', {
                pullRequestNumber, comments: [], repoOwner, repoName,
                branchName: jobBranchName, llm: jobLlm, correlationId: generateCorrelationId(),
            }, { jobId: followUpJobId, delay: 3000 });

            correlatedLogger.info({ jobId: followUpJobId, pullRequestNumber }, 'Queued follow-up job for pending comments');
        }
    } catch (pendingCheckError) {
        correlatedLogger.warn({ error: pendingCheckError.message }, 'Failed to check/queue pending comments');
    }
}
