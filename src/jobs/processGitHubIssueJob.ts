import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { Redis } from 'ioredis';
import { logger } from '@gitfix/core';
import { generateCorrelationId } from '@gitfix/core';
import { handleError } from '@gitfix/core';
import { getAuthenticatedOctokit } from '@gitfix/core';
import { withRetry, retryConfigs } from '@gitfix/core';
import { getStateManager, TaskStates } from '@gitfix/core';
import type { WorkerStateManager, IssueRef } from '@gitfix/core';
import { ensureRepoCloned, createWorktreeForIssue, getRepoUrl, pushBranch } from '@gitfix/core';
import type { WorktreeInfo, CommitResult } from '@gitfix/core';
import { addModelSpecificDelay } from '@gitfix/core';
import { safeAddLabel } from '@gitfix/core';
import { ensureGitRepository } from '@gitfix/core';
import { UsageLimitError } from '@gitfix/core';
import type { ClaudeCodeResponse } from '@gitfix/core';
import { validateRepositoryInfo } from '@gitfix/core';
import type { RepoValidationResult } from '@gitfix/core';
import { getDefaultModel } from '@gitfix/core';
import { loadPrLabel, loadPrimaryProcessingLabels } from '@gitfix/core';
import { filterCommentByAuthor } from '@gitfix/core';
import { AgentRegistry, resolveLlmLabel, updateFileChanges } from '@gitfix/core';
import { handleDispatch } from './issueJobDispatcher.js';
import { handleUsageLimitError, handleGenericError, updateTaskTitleInStorage, buildFinalResult } from './issueJobHelpers.js';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { performPostProcessing, performFinalValidation } from './issueJobPostProcessing.js';
import type { IssueJobData, JobResult } from '@gitfix/core';
import { executeAgentAndRecordMetrics, type ExecutionParams } from './issueJobAgent.js';

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

type RepoValidation = RepoValidationResult;

interface GitHubToken {
    token: string;
}

interface JobContext {
    jobId: string | undefined;
    jobName: string;
    issueRef: IssueJobData;
    correlationId: string;
    correlatedLogger: Logger;
    stateManager: WorkerStateManager;
    agentAlias: string;
    modelName: string;
    taskId: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    AI_PRIMARY_TAG: string;
    PR_LABEL: string;
}

interface CurrentIssueData {
    data: {
        title: string;
        body: string | null | undefined;
        labels: Array<{ name: string }>;
        created_at: string;
        updatedAt?: string;
        user: { login: string };
    };
}

interface IssueComment {
    id: number;
    body: string;
    body_html?: string;  // HTML with signed image URLs
    user: { login: string; type?: string };
}


interface LabelCheckResult {
    skip: boolean;
    reason?: string;
}

interface TaskCompletionParams {
    stateManager: WorkerStateManager;
    taskId: string;
    claudeResult: ClaudeCodeResponse | null;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    correlatedLogger: Logger;
}

interface WorktreeExecutionParams {
    job: Job<IssueJobData>;
    context: JobContext;
    octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never;
    currentIssueData: CurrentIssueData;
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    repoUrl: string;
}

interface WorktreeExecutionResult {
    localRepoPath: string;
    worktreeInfo: WorktreeInfo;
    claudeResult: ClaudeCodeResponse;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
}

async function getPrimaryProcessingLabels(): Promise<string[]> {
    try {
        if (process.env.CONFIG_REPO) return await loadPrimaryProcessingLabels();
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
        if (process.env.CONFIG_REPO) return await loadPrLabel();
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

    // Get agent alias from job data, or resolve from model name, or use default
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    let agentAlias = issueRef.agentAlias;
    let modelName = issueRef.modelName;

    // If agentAlias is missing but we have a modelName, try to resolve the agent from the model
    if (!agentAlias && modelName) {
        const resolution = await resolveLlmLabel(modelName);
        agentAlias = resolution.agentAlias;
        // Keep original modelName if it was specific, otherwise use resolved one
        correlatedLogger.debug({ originalModel: modelName, resolvedAgent: agentAlias }, 'Resolved agent from model name');
    }

    // Fallback to default agent if still missing
    if (!agentAlias) {
        const defaultAgent = registry.getDefaultAgent();
        agentAlias = defaultAgent?.config.alias || 'default';
    }

    // Get model if still missing (use agent's default model)
    const agent = registry.getAgentByAlias(agentAlias);
    modelName = modelName || agent?.config.defaultModel || DEFAULT_MODEL_NAME;

    const taskId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}-${agentAlias}-${modelName}`;

    return {
        jobId, jobName, issueRef, correlationId, correlatedLogger, stateManager, agentAlias, modelName, taskId,
        AI_PROCESSING_TAG: `${triggeringLabel}-processing`,
        AI_DONE_TAG: `${triggeringLabel}-done`,
        AI_PRIMARY_TAG: triggeringLabel,
        PR_LABEL: await getPrLabel()
    };
}

async function getAuthenticatedClient(context: JobContext): Promise<ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never> {
    const { correlationId, stateManager, taskId, correlatedLogger, issueRef } = context;
    try {
        return await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
    } catch (authError) {
        const errorDetails = handleError(authError, 'Worker: Failed to get authenticated Octokit instance', { correlationId, issueRef });
        try {
            await stateManager.markTaskFailed(taskId, authError as Error, { errorCategory: errorDetails.category });
        } catch (stateError) {
            correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update task state to failed');
        }
        throw authError;
    }
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

async function fetchIssueComments(octokit: ExecutionParams['octokit'], issueRef: IssueJobData, correlatedLogger: Logger): Promise<IssueComment[]> {
    try {
        // Use request for mediaType support - paginate doesn't support it well
        const commentsResp = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number, per_page: 100,
            mediaType: { format: 'full' }  // Get body_html with signed image URLs
        }) as { data: IssueComment[] };
        const allComments = commentsResp.data;
        return allComments.filter(comment => {
            const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type);
            return !filterResult.shouldFilter;
        });
    } catch (commentError) {
        correlatedLogger.warn({ issueNumber: issueRef.number, error: (commentError as Error).message }, 'Failed to fetch issue comments, continuing without them');
        return [];
    }
}


export async function processGitHubIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
    if (!job.data.isChildJob) {
        logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
        return await handleDispatch(job);
    }

    const context = await initializeJobContext(job);
    await addModelSpecificDelay(context.modelName);
    await initializeTaskState(context);

    const octokit = await getAuthenticatedClient(context);
    return processChildJob(job, context, octokit);
}

async function initializeTaskState(context: JobContext): Promise<void> {
    const { stateManager, taskId, issueRef, correlatedLogger, correlationId } = context;
    try {
        await stateManager.createTaskState(taskId, { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName } as IssueRef, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create task state, continuing anyway');
    }
}

async function processChildJob(
    job: Job<IssueJobData>,
    context: JobContext,
    octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never
): Promise<JobResult> {
    const { issueRef, correlationId, correlatedLogger, stateManager, taskId } = context;
    let executionResult: WorktreeExecutionResult | undefined;

    try {
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting issue processing' });

        const currentIssueData = await fetchCurrentIssueData(octokit, issueRef, correlationId);
        const labelCheck = checkLabelConditions(currentIssueData.data.labels.map(label => label.name), context);
        if (labelCheck.skip) return { status: 'skipped', reason: labelCheck.reason, issueNumber: issueRef.number };

        await ensureProcessingLabel(octokit, currentIssueData.data.labels.map(l => l.name), context);
        await updateTaskTitleInStorage(taskId, { ...issueRef, title: `New Issue: ${currentIssueData.data.title}`, subtitle: `Preparing a PR for issue #${issueRef.number}` }, stateManager, correlatedLogger);
        await job.updateProgress(25);

        const repoValidation = await getRepoValidation(issueRef, octokit, correlationId);
        const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;
        const repoUrl = getRepoUrl(issueRef);

        try {
            executionResult = await executeWorktreeOperations({ job, context, octokit, currentIssueData, repoValidation, githubToken, repoUrl });
        } finally {
            await runFinalValidation({ executionResult, context, octokit, repoValidation, githubToken, repoUrl });
        }

        await job.updateProgress(100);
        await storeFinalFileChanges(executionResult, taskId, correlatedLogger);
        await markTaskComplete({ stateManager, taskId, claudeResult: executionResult?.claudeResult || null, postProcessingResult: executionResult?.postProcessingResult || null, commitResult: executionResult?.commitResult || null, correlatedLogger });

        return buildFinalResult(issueRef, executionResult?.localRepoPath || '', { worktreeInfo: executionResult?.worktreeInfo, claudeResult: executionResult?.claudeResult || null, postProcessingResult: executionResult?.postProcessingResult || null, commitResult: executionResult?.commitResult || null });
    } catch (error) {
        return handleJobError({ error: error as Error, job, executionResult, context, octokit });
    }
}

async function fetchCurrentIssueData(octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never, issueRef: IssueJobData, correlationId: string): Promise<CurrentIssueData> {
    if (issueRef.issuePayload) {
        return { data: issueRef.issuePayload as CurrentIssueData['data'] };
    }
    return await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
        mediaType: { format: 'full' }
    }), { ...retryConfigs.githubApi, correlationId }, `get_issue_${issueRef.number}`) as unknown as CurrentIssueData;
}

async function ensureProcessingLabel(octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never, currentLabels: string[], context: JobContext): Promise<void> {
    const { issueRef, correlatedLogger, AI_PROCESSING_TAG } = context;
    if (!currentLabels.includes(AI_PROCESSING_TAG)) {
        await safeAddLabel({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, AI_PROCESSING_TAG);
    }
}

async function getRepoValidation(issueRef: IssueJobData, octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never, correlationId: string): Promise<RepoValidation> {
    if (issueRef.repoPayload) {
        return { isValid: true, repoData: issueRef.repoPayload as unknown as RepoValidation['repoData'] };
    }
    return await validateRepositoryInfo({ repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, number: issueRef.number }, octokit, correlationId);
}

interface FinalValidationParams {
    executionResult: WorktreeExecutionResult | undefined;
    context: JobContext;
    octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never;
    repoValidation: RepoValidation;
    githubToken: GitHubToken;
    repoUrl: string;
}

async function runFinalValidation(params: FinalValidationParams): Promise<void> {
    const { executionResult, context, octokit, repoValidation, githubToken, repoUrl } = params;
    const { issueRef, jobId, correlationId, correlatedLogger, modelName } = context;
    await performFinalValidation({
        claudeResult: executionResult?.claudeResult, worktreeInfo: executionResult?.worktreeInfo, issueRef, octokit,
        postProcessingResult: executionResult?.postProcessingResult || null, repoValidation, githubToken, modelName,
        AI_PROCESSING_TAG: context.AI_PROCESSING_TAG, AI_DONE_TAG: context.AI_DONE_TAG,
        localRepoPath: executionResult?.localRepoPath || '', jobId, correlationId, correlatedLogger, PR_LABEL: context.PR_LABEL, repoUrl
    });
}

async function storeFinalFileChanges(executionResult: WorktreeExecutionResult | undefined, taskId: string, correlatedLogger: Logger): Promise<void> {
    if (!executionResult?.worktreeInfo) return;
    try {
        await updateFileChanges(redisClient, taskId, executionResult.worktreeInfo.worktreePath, false);
        correlatedLogger.debug({ taskId }, 'Stored final file changes state');
    } catch (fileChangesError) {
        correlatedLogger.warn({ taskId, error: (fileChangesError as Error).message }, 'Failed to store final file changes');
    }
}

interface JobErrorParams {
    error: Error;
    job: Job<IssueJobData>;
    executionResult: WorktreeExecutionResult | undefined;
    context: JobContext;
    octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never;
}

async function handleJobError(params: JobErrorParams): Promise<JobResult> {
    const { error, job, executionResult, context, octokit } = params;
    const { issueRef, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG } = context;
    if (error instanceof UsageLimitError) {
        await handleUsageLimitError(error, job, issueRef, { octokit, correlatedLogger, stateManager, taskId });
        return { status: 'error', error: error.message };
    }
    await handleGenericError(error, job, issueRef, { octokit, claudeResult: executionResult?.claudeResult || null, worktreeInfo: executionResult?.worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG });
    const isUserCancelled = error.message?.includes('aborted by user') || error.name === 'ExecutionAbortedError';
    if (isUserCancelled) {
        return { status: 'cancelled', reason: 'user_request' };
    }
    throw error;
}

async function markTaskComplete(taskCompletionParams: TaskCompletionParams): Promise<void> {
    const { stateManager, taskId, claudeResult, postProcessingResult, commitResult, correlatedLogger } = taskCompletionParams;
    try {
        const status = claudeResult?.success ? (postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes') : 'claude_processing_failed';
        await stateManager.markTaskCompleted(taskId, {
            status, claudeSuccess: claudeResult?.success || false, prCreated: !!postProcessingResult?.pr,
            prNumber: postProcessingResult?.pr?.number ?? undefined, prUrl: postProcessingResult?.pr?.url ?? undefined,
            commitResult: commitResult ? { commitHash: commitResult.commitHash, commitMessage: commitResult.commitMessage } : null
        });
    } catch (stateError) {
        correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update task state to completed');
    }
}

async function executeWorktreeOperations(params: WorktreeExecutionParams): Promise<WorktreeExecutionResult> {
    const { job, context, octokit, currentIssueData, repoValidation, githubToken, repoUrl } = params;
    const { issueRef, correlatedLogger, stateManager, agentAlias, modelName, taskId } = context;

    await ensureGitRepository(correlatedLogger);
    const localRepoPath = await ensureRepoCloned({ repoUrl, owner: issueRef.repoOwner, repoName: issueRef.repoName, authToken: githubToken.token });
    await job.updateProgress(50);

    const worktreeInfo = await createWorktreeForIssue(localRepoPath, { issueId: issueRef.number, issueTitle: currentIssueData.data.title, owner: issueRef.repoOwner, repoName: issueRef.repoName }, { baseBranch: issueRef.baseBranch || null, octokit, modelName });

    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
        reason: 'Worktree created',
        historyMetadata: { worktreePath: worktreeInfo.worktreePath }
    });
    await job.updateProgress(75);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const taskUrl = `${frontendUrl}/tasks/${taskId}`;

    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
        body: `🤖 AI processing has started for this issue using **${agentAlias}** agent with **${modelName}** model.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.\n\n**Processing Details:**\n- Agent: \`${agentAlias}\`\n- Model: \`${modelName}\`\n- Branch: \`${worktreeInfo.branchName}\`\n- Base Branch: \`${issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main'}\`\n- Worktree: \`${worktreeInfo.worktreePath.split('/').pop()}\`\n\n🔍 [Track Task Execution](${taskUrl})`,
    });

    await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token });
    await job.updateProgress(80);

    const issueComments = await fetchIssueComments(octokit, issueRef, correlatedLogger);
    const claudeResult = await executeAgentAndRecordMetrics(
        { octokit, worktreeInfo, issueRef, githubToken, currentIssueData, issueComments },
        { taskId, agentAlias, modelName, stateManager, correlatedLogger, correlationId: context.correlationId },
        redisClient
    );

    try {
        await updateFileChanges(redisClient, taskId, worktreeInfo.worktreePath, true);
        correlatedLogger.debug({ taskId }, 'Updated file changes after agent execution');
    } catch (fileChangesError) {
        correlatedLogger.warn({ taskId, error: (fileChangesError as Error).message }, 'Failed to update file changes');
    }

    const postProcessResult = await performPostProcessing({ octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL: context.PR_LABEL, AI_PROCESSING_TAG: context.AI_PROCESSING_TAG, AI_DONE_TAG: context.AI_DONE_TAG, jobId: context.jobId, correlatedLogger });
    await job.updateProgress(95);

    return {
        localRepoPath,
        worktreeInfo,
        claudeResult,
        postProcessingResult: postProcessResult.postProcessingResult,
        commitResult: postProcessResult.commitResult
    };
}

export { processGitHubIssueJob as default };
