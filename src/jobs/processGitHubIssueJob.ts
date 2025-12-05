import logger, { generateCorrelationId } from '../utils/logger.js';
import type { Logger } from 'pino';
import { handleError } from '../utils/errorHandler.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates, WorkerStateManager } from '../utils/workerStateManager.js';
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
import { Redis } from 'ioredis';
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
import type { IssueJobData, Job, JobResult } from '../queue/taskQueue.js';
import type { Octokit } from '@octokit/core';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

interface IssueRef {
    repoOwner: string;
    repoName: string;
    number: number;
    correlationId?: string;
    triggeringLabel?: string;
    modelName?: string;
    baseBranch?: string;
    baseLabel?: string;
    modelLabel?: string;
    issuePayload?: Record<string, unknown>;
    repoPayload?: Record<string, unknown>;
    title?: string;
    subtitle?: string;
}

interface ClaudeResult {
    success: boolean;
    executionTime?: number;
    sessionId?: string;
    conversationId?: string;
    model?: string;
    suggestedCommitMessage?: string;
    error?: string;
    modifiedFiles?: string[];
    conversationLog?: unknown[];
}

interface WorktreeInfo {
    worktreePath: string;
    branchName: string;
}

interface CommitResult {
    commitHash: string;
    commitMessage: string;
}

interface PostProcessingResult {
    success: boolean;
    pr?: {
        number: number;
        url: string;
        title: string;
    } | null;
    updatedLabels?: string[];
    error?: string;
}

interface RepoValidation {
    isValid: boolean;
    repoData: {
        defaultBranch: string;
        [key: string]: unknown;
    };
}

interface GitHubToken {
    token: string;
}

interface IssueData {
    data: {
        title: string;
        body: string | null;
        labels: Array<{ name: string }>;
        created_at: string;
        updated_at: string;
        user: { login: string };
    };
}

interface JobContext {
    jobId: string;
    jobName: string;
    issueRef: IssueRef;
    correlationId: string;
    correlatedLogger: Logger;
    stateManager: WorkerStateManager;
    modelName: string;
    taskId: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    AI_PRIMARY_TAG: string;
    PR_LABEL: string;
}

async function getPrimaryProcessingLabels(): Promise<string[]> {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadPrimaryProcessingLabels();
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to load primary processing labels from config, using fallback');
    }

    if (process.env.PRIMARY_PROCESSING_LABELS) {
        return process.env.PRIMARY_PROCESSING_LABELS.split(',').map(l => l.trim()).filter(l => l);
    }

    return [process.env.AI_PRIMARY_TAG || 'AI'];
}

async function getPrLabel(): Promise<string> {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadPrLabel();
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to load PR label from config, using fallback');
    }
    return process.env.PR_LABEL || 'gitfix';
}

async function initializeJobContext(job: Job<IssueJobData>): Promise<JobContext> {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();

    const primaryProcessingLabels = await getPrimaryProcessingLabels();
    const triggeringLabel = issueRef.triggeringLabel || primaryProcessingLabels[0] || 'AI';
    const modelName = issueRef.modelName || DEFAULT_MODEL_NAME;
    const taskId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${modelName}`;

    return {
        jobId: jobId || '', jobName, issueRef: issueRef as IssueRef, correlationId, correlatedLogger, stateManager,
        modelName, taskId,
        AI_PROCESSING_TAG: `${triggeringLabel}-processing`,
        AI_DONE_TAG: `${triggeringLabel}-done`,
        AI_PRIMARY_TAG: triggeringLabel,
        PR_LABEL: await getPrLabel()
    };
}

async function getAuthenticatedClient(context: JobContext): Promise<Octokit> {
    const { correlationId, stateManager, taskId, correlatedLogger, issueRef } = context;
    try {
        return await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );
    } catch (authError) {
        const errorDetails = handleError(authError as Error, 'Worker: Failed to get authenticated Octokit instance', { correlationId, issueRef });
        try {
            await stateManager.markTaskFailed(taskId, authError as Error, { errorCategory: errorDetails.category });
        } catch (stateError) {
            correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update task state to failed');
        }
        throw authError;
    }
}

interface LabelCheckResult {
    skip: boolean;
    reason?: string;
}

function checkLabelConditions(currentLabels: string[], context: JobContext): LabelCheckResult {
    const { jobId, issueRef, AI_PRIMARY_TAG, AI_DONE_TAG } = context;

    if (!currentLabels.includes(AI_PRIMARY_TAG)) {
        logger.warn({ jobId, issueNumber: issueRef.number }, `Issue no longer has primary tag '${AI_PRIMARY_TAG}'. Skipping.`);
        return { skip: true, reason: 'Primary tag missing' };
    }
    if (currentLabels.includes(AI_DONE_TAG)) {
        logger.warn({ jobId, issueNumber: issueRef.number }, `Issue already has '${AI_DONE_TAG}' tag. Skipping.`);
        return { skip: true, reason: 'Already done' };
    }
    return { skip: false };
}

interface IssueComment {
    user: { login: string; type: string };
    body: string;
}

async function fetchIssueComments(octokit: Octokit, issueRef: IssueRef, correlatedLogger: Logger): Promise<IssueComment[]> {
    try {
        const allComments = await (octokit as unknown as { paginate: (url: string, params: Record<string, unknown>) => Promise<IssueComment[]> }).paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number, per_page: 100
        });
        return allComments.filter(comment => {
            const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type);
            return !filterResult.shouldFilter;
        });
    } catch (commentError) {
        correlatedLogger.warn({ issueNumber: issueRef.number, error: (commentError as Error).message }, 'Failed to fetch issue comments, continuing without them');
        return [];
    }
}

interface ExecutionParams {
    worktreeInfo: WorktreeInfo;
    githubToken: GitHubToken;
    currentIssueData: IssueData;
    issueComments: IssueComment[];
}

async function executeClaudeAndRecordMetrics(executionParams: ExecutionParams, context: JobContext): Promise<ClaudeResult> {
    const { worktreeInfo, githubToken, currentIssueData, issueComments } = executionParams;
    const { issueRef, taskId, modelName, stateManager, correlatedLogger, correlationId } = context;

    const claudeResult = await executeClaudeCode({
        worktreePath: worktreeInfo.worktreePath,
        issueRef, githubToken: githubToken.token, branchName: worktreeInfo.branchName, modelName,
        issueDetails: {
            title: currentIssueData.data.title, body: currentIssueData.data.body || undefined, comments: issueComments,
            labels: currentIssueData.data.labels, created_at: currentIssueData.data.created_at,
            updated_at: currentIssueData.data.updated_at, user: currentIssueData.data.user
        },
        onSessionId: createSessionIdCallback(taskId, issueRef, { modelName, stateManager, correlatedLogger }) as (sessionId: string, conversationId?: string) => void,
        onContainerId: createContainerIdCallback(taskId, stateManager, correlatedLogger)
    });

    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: 'Claude execution completed',
        claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId || undefined, conversationId: claudeResult.conversationId || undefined, executionTime: claudeResult.executionTime },
        historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model }
    });

    await recordLLMMetrics(claudeResult as Parameters<typeof recordLLMMetrics>[0], issueRef, { jobType: 'issue', correlationId, taskId });
    return claudeResult as unknown as ClaudeResult;
}

async function processGitHubIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
    logger.debug({ jobId: job.id, isChildJob: job.data.isChildJob, hasModelName: !!job.data.modelName }, 'Checking if job should be dispatched');

    if (!job.data.isChildJob) {
        logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
        return await handleDispatch(job) as unknown as JobResult;
    }

    const context = await initializeJobContext(job);
    const { jobId, jobName, issueRef, correlationId, correlatedLogger, stateManager, modelName, taskId, AI_PROCESSING_TAG, AI_DONE_TAG, PR_LABEL } = context;

    await addModelSpecificDelay(modelName);

    try {
        await stateManager.createTaskState(taskId, issueRef as unknown as import('../utils/workerStateManager.types.js').IssueRef, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create task state, continuing anyway');
    }

    correlatedLogger.info({ jobId, jobName, taskId, issueNumber: issueRef.number, repo: `${issueRef.repoOwner}/${issueRef.repoName}` }, 'Processing job started');

    const octokit = await getAuthenticatedClient(context);

    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    let claudeResult: ClaudeResult | null = null;
    let postProcessingResult: PostProcessingResult | null = null;
    let commitResult: CommitResult | null = null;

    try {
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting issue processing' });

        const currentIssueData: IssueData = issueRef.issuePayload ? { data: issueRef.issuePayload as IssueData['data'] } :
            await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
            }), { ...retryConfigs.githubApi, correlationId }, `get_issue_${issueRef.number}`) as IssueData;

        const currentLabels = currentIssueData.data.labels.map(label => label.name);
        const labelCheck = checkLabelConditions(currentLabels, context);
        if (labelCheck.skip) return { status: 'skipped', reason: labelCheck.reason, issueNumber: issueRef.number };

        if (!currentLabels.includes(AI_PROCESSING_TAG)) {
            await safeAddLabel({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, AI_PROCESSING_TAG);
        }

        issueRef.title = `New Issue: ${currentIssueData.data.title}`;
        issueRef.subtitle = `Preparing a PR for issue #${issueRef.number}`;
        await updateTaskTitleInStorage(taskId, issueRef, stateManager, correlatedLogger);
        await job.updateProgress(25);

        const validationResult = issueRef.repoPayload ? { isValid: true, repoData: issueRef.repoPayload as RepoValidation['repoData'] } : await validateRepositoryInfo(issueRef, octokit, correlationId);
        const repoValidation: RepoValidation = { isValid: validationResult.isValid, repoData: (validationResult.repoData as RepoValidation['repoData']) || { defaultBranch: 'main' } };
        const githubToken = await octokit.auth() as GitHubToken;
        const repoUrl = getRepoUrl(issueRef);

        try {
            await ensureGitRepository(correlatedLogger);
            localRepoPath = await ensureRepoCloned(repoUrl, issueRef.repoOwner, issueRef.repoName, githubToken.token);
            await job.updateProgress(50);

            worktreeInfo = await createWorktreeForIssue(localRepoPath, { issueId: issueRef.number, issueTitle: currentIssueData.data.title, owner: issueRef.repoOwner, repoName: issueRef.repoName }, { baseBranch: issueRef.baseBranch || null, octokit, modelName });
            await job.updateProgress(75);

            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
                body: `🤖 AI processing has started for this issue using **${modelName}** model.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.\n\n**Processing Details:**\n- Model: \`${modelName}\`\n- Branch: \`${worktreeInfo.branchName}\`\n- Base Branch: \`${issueRef.baseBranch || repoValidation.repoData.defaultBranch}\`\n- Worktree: \`${worktreeInfo.worktreePath.split('/').pop()}\``,
            });

            await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token, tokenRefreshFn: async () => ((await octokit.auth()) as GitHubToken).token, correlationId });
            await job.updateProgress(80);

            const issueComments = await fetchIssueComments(octokit, issueRef, correlatedLogger);
            claudeResult = await executeClaudeAndRecordMetrics({ octokit, worktreeInfo, issueRef, githubToken, currentIssueData, issueComments } as unknown as ExecutionParams, context);

            const postProcessResult = await performPostProcessing({ octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger });
            commitResult = postProcessResult.commitResult;
            postProcessingResult = postProcessResult.postProcessingResult;
            await job.updateProgress(95);

        } finally {
            await performFinalValidation({ claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath, jobId, correlationId, correlatedLogger });
        }

        await job.updateProgress(100);
        await markTaskComplete({ stateManager, taskId, claudeResult, postProcessingResult, commitResult, correlatedLogger });
        return buildFinalResult(issueRef, localRepoPath!, { worktreeInfo, claudeResult, postProcessingResult, commitResult });

    } catch (error) {
        if (error instanceof UsageLimitError) {
            await handleUsageLimitError(error, job, issueRef, { octokit, correlatedLogger, stateManager, taskId });
        } else {
            await handleGenericError(error as Error, job, issueRef, { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG });
            throw error;
        }
        return { status: 'requeued', issueNumber: issueRef.number };
    }
}

interface TaskCompletionParams {
    stateManager: WorkerStateManager;
    taskId: string;
    claudeResult: ClaudeResult | null;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    correlatedLogger: Logger;
}

async function markTaskComplete(taskCompletionParams: TaskCompletionParams): Promise<void> {
    const { stateManager, taskId, claudeResult, postProcessingResult, commitResult, correlatedLogger } = taskCompletionParams;
    try {
        const status = claudeResult?.success ? (postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes') : 'claude_processing_failed';
        await stateManager.markTaskCompleted(taskId, {
            status, claudeSuccess: claudeResult?.success || false, prCreated: !!postProcessingResult?.pr,
            prNumber: postProcessingResult?.pr?.number, prUrl: postProcessingResult?.pr?.url,
            commitResult: commitResult ? { commitHash: commitResult.commitHash, commitMessage: commitResult.commitMessage } : null
        });
    } catch (stateError) {
        correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update task state to completed');
    }
}

interface SessionIdCallbackOptions {
    modelName: string;
    stateManager: WorkerStateManager;
    correlatedLogger: Logger;
}

function createSessionIdCallback(taskId: string, issueRef: IssueRef, options: SessionIdCallbackOptions): (sessionId: string, conversationId?: string) => Promise<void> {
    const { modelName, stateManager, correlatedLogger } = options;
    return async (sessionId: string, conversationId?: string) => {
        try {
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
                reason: 'Claude execution started',
                claudeResult: { success: false, sessionId, conversationId },
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

            const { Redis: RedisClient } = await import('ioredis');
            const redis = new RedisClient({ host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
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
            correlatedLogger.warn({ error: (error as Error).message, taskId, sessionId }, 'Failed to update task state with early sessionId');
        }
    };
}

function createContainerIdCallback(taskId: string, stateManager: WorkerStateManager, correlatedLogger: Logger): (containerId: string, containerName: string) => Promise<void> {
    return async (containerId: string, containerName: string) => {
        try {
            await stateManager.updateHistoryMetadata(taskId, 'claude_execution', { containerId, containerName });
        } catch (err) {
            correlatedLogger.warn({ taskId, error: (err as Error).message }, 'Failed to update state with container info');
        }
    };
}

interface PostProcessingOptions {
    octokit: Octokit;
    issueRef: IssueRef;
    worktreeInfo: WorktreeInfo;
    currentIssueData: IssueData;
    claudeResult: ClaudeResult;
    modelName: string;
    repoValidation: RepoValidation;
    repoUrl: string;
    githubToken: GitHubToken;
    PR_LABEL: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    jobId: string;
    correlatedLogger: Logger;
}

interface PostProcessingReturn {
    commitResult: CommitResult | null;
    postProcessingResult: PostProcessingResult | null;
}

async function performPostProcessing(options: PostProcessingOptions): Promise<PostProcessingReturn> {
    const { octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger } = options;
    let commitResult: CommitResult | null = null;
    let postProcessingResult: PostProcessingResult | null = null;

    try {
        let commitMessage = `fix(ai): Resolve issue #${issueRef.number} - ${currentIssueData.data.title.substring(0, 50)}\n\nImplemented by Claude Code using ${modelName} model.\n\n${claudeResult?.success ? 'Implementation completed successfully.' : 'Implementation attempted - see PR comments for details.'}`;

        if (claudeResult?.suggestedCommitMessage) {
            commitMessage = claudeResult.suggestedCommitMessage;
        }

        commitResult = await commitChanges(
            worktreeInfo.worktreePath, commitMessage,
            { name: 'Claude Code', email: 'claude-code@anthropic.com' },
            { issueNumber: issueRef.number, issueTitle: currentIssueData.data.title }
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
        correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (postProcessingError as Error).message }, 'Deterministic post-processing failed');

        try {
            await safeUpdateLabels({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, [AI_PROCESSING_TAG], [AI_DONE_TAG]);
            const completionComment = await generateCompletionComment(claudeResult, issueRef);
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
                body: `⚠️ **Post-processing encountered an error, but Claude analysis was completed.**\n\n${completionComment}`,
            });
            postProcessingResult = { success: false, pr: null, updatedLabels: [AI_DONE_TAG], error: (postProcessingError as Error).message };
        } catch (fallbackError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (fallbackError as Error).message }, 'Fallback post-processing also failed');
            postProcessingResult = { success: false, pr: null, updatedLabels: [], error: (postProcessingError as Error).message };
        }
    }

    return { commitResult, postProcessingResult };
}

interface PRValidationOptions {
    claudeResult: ClaudeResult | null;
    worktreeInfo?: WorktreeInfo;
    issueRef: IssueRef;
    octokit: Octokit;
    postProcessingResult: PostProcessingResult | null;
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    modelName: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlationId: string;
    correlatedLogger: Logger;
}

async function handlePRValidation(options: PRValidationOptions): Promise<PostProcessingResult | null> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger } = options;

    if (!worktreeInfo) return postProcessingResult;

    const finalPRValidation = await validatePRCreation({
        owner: issueRef.repoOwner, repoName: issueRef.repoName,
        branchName: worktreeInfo.branchName, expectedPrNumber: postProcessingResult?.pr?.number, correlationId
    });

    if (finalPRValidation.isValid && !postProcessingResult?.pr) {
        await safeUpdateLabels({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, [AI_PROCESSING_TAG], [AI_DONE_TAG]);
        return { success: true, pr: finalPRValidation.pr, updatedLabels: postProcessingResult?.updatedLabels || [] };
    }

    if (!finalPRValidation.isValid && claudeResult?.success) {
        await attemptEmergencyPRCreation({ worktreeInfo, issueRef, repoValidation, githubToken, modelName, correlationId, correlatedLogger });
    }
    return postProcessingResult;
}

interface CleanupOptions {
    worktreeInfo?: WorktreeInfo;
    localRepoPath?: string;
    claudeResult: ClaudeResult | null;
    postProcessingResult: PostProcessingResult | null;
    jobId: string;
    issueRef: IssueRef;
    correlatedLogger: Logger;
}

async function cleanupWorktreeIfExists(options: CleanupOptions): Promise<void> {
    const { worktreeInfo, localRepoPath, claudeResult, postProcessingResult, jobId, issueRef, correlatedLogger } = options;
    if (!worktreeInfo || !localRepoPath) return;

    try {
        const wasSuccessful = claudeResult?.success && postProcessingResult?.pr;
        await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
            deleteBranch: !wasSuccessful, success: !!wasSuccessful,
            retentionStrategy: process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete'
        });
    } catch (cleanupError) {
        correlatedLogger.warn({ jobId, issueNumber: issueRef.number, error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
    }
}

interface FinalValidationOptions {
    claudeResult: ClaudeResult | null;
    worktreeInfo?: WorktreeInfo;
    issueRef: IssueRef;
    octokit: Octokit;
    postProcessingResult: PostProcessingResult | null;
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    modelName: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    localRepoPath?: string;
    jobId: string;
    correlationId: string;
    correlatedLogger: Logger;
}

async function performFinalValidation(options: FinalValidationOptions): Promise<void> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath, jobId, correlationId, correlatedLogger } = options;
    let resolvedPostProcessingResult = postProcessingResult;

    if (claudeResult?.success && worktreeInfo?.branchName) {
        try {
            resolvedPostProcessingResult = await handlePRValidation({ claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger });
        } catch (validationError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (validationError as Error).message }, 'Final PR validation failed');
        }
    }

    await cleanupWorktreeIfExists({ worktreeInfo, localRepoPath, claudeResult, postProcessingResult: resolvedPostProcessingResult, jobId, issueRef, correlatedLogger });
}

interface EmergencyPROptions {
    worktreeInfo: WorktreeInfo;
    issueRef: IssueRef;
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    modelName: string;
    correlationId: string;
    correlatedLogger: Logger;
}

async function attemptEmergencyPRCreation(options: EmergencyPROptions): Promise<void> {
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
            branchName: worktreeInfo.branchName, expectedPrNumber: undefined, correlationId
        });

        if (emergencyValidation.isValid) {
            correlatedLogger.info({ issueNumber: issueRef.number, prNumber: emergencyValidation.pr?.number }, 'Emergency PR creation successful');
        }
    }
}

export { processGitHubIssueJob };
