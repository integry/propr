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
import type { ClaudeResult } from '@gitfix/core';
import { recordLLMMetrics } from '@gitfix/core';
import { validateRepositoryInfo } from '@gitfix/core';
import type { RepoValidationResult } from '@gitfix/core';
import { getDefaultModel } from '@gitfix/core';
import { loadPrLabel, loadPrimaryProcessingLabels } from '@gitfix/core';
import { filterCommentByAuthor } from '@gitfix/core';
import { AgentRegistry, generateClaudePrompt, resolveLlmLabel } from '@gitfix/core';
import type { AgentExecutionResult } from '@gitfix/core';
import { handleDispatch } from './issueJobDispatcher.js';
import { handleUsageLimitError, handleGenericError, updateTaskTitleInStorage, buildFinalResult, localizeContentImages } from './issueJobHelpers.js';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { createSessionIdCallback, createContainerIdCallback } from './issueJobCallbacks.js';
import { performPostProcessing, performFinalValidation } from './issueJobPostProcessing.js';
import type { IssueJobData, JobResult } from '@gitfix/core';

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
    user: { login: string; type?: string };
}

interface ExecutionParams {
    octokit: ReturnType<typeof getAuthenticatedOctokit> extends Promise<infer T> ? T : never;
    worktreeInfo: WorktreeInfo;
    issueRef: IssueJobData;
    githubToken: GitHubToken;
    currentIssueData: CurrentIssueData;
    issueComments: IssueComment[];
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
        const allComments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number, per_page: 100
        }) as IssueComment[];
        return allComments.filter(comment => {
            const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type);
            return !filterResult.shouldFilter;
        });
    } catch (commentError) {
        correlatedLogger.warn({ issueNumber: issueRef.number, error: (commentError as Error).message }, 'Failed to fetch issue comments, continuing without them');
        return [];
    }
}

function toClaudeResult(response: AgentExecutionResult): ClaudeResult {
    return {
        model: response.modelUsed,
        success: response.success,
        executionTime: response.executionTimeMs,
        sessionId: response.sessionId,
        conversationId: response.conversationId,
        finalResult: response.summary ? { type: 'result', result: response.summary } : null,
        conversationLog: undefined,
        error: response.error
    };
}

/**
 * Converts AgentExecutionResult to ClaudeCodeResponse for backwards compatibility
 * with existing post-processing code.
 */
function agentResultToClaudeResponse(result: AgentExecutionResult): ClaudeCodeResponse {
    return {
        success: result.success,
        model: result.modelUsed,
        executionTime: result.executionTimeMs,
        output: null,
        sessionId: result.sessionId || null,
        conversationId: result.conversationId,
        finalResult: result.summary ? { type: 'result', result: result.summary } : null,
        rawOutput: result.rawOutput,
        summary: result.summary || null,
        logs: result.logs,
        exitCode: result.exitCode ?? null,
        error: result.error,
        modifiedFiles: result.modifiedFiles,
        commitMessage: result.commitMessage || null
    };
}

async function executeAgentAndRecordMetrics(executionParams: ExecutionParams, context: JobContext): Promise<ClaudeCodeResponse> {
    const { worktreeInfo, issueRef, githubToken, currentIssueData, issueComments } = executionParams;
    const { taskId, agentAlias, modelName, stateManager, correlatedLogger, correlationId } = context;

    // Get the agent from registry
    const registry = AgentRegistry.getInstance();
    const agent = registry.getAgentByAlias(agentAlias);

    if (!agent) {
        throw new Error(`Agent not found: ${agentAlias}`);
    }

    correlatedLogger.info({
        agentAlias,
        agentType: agent.config.type,
        modelName,
        issueNumber: issueRef.number
    }, 'Executing task with agent');

    // Localize remote images in issue body and comments
    // This downloads images to the worktree so the agent can access them
    const localizedBody = currentIssueData.data.body
        ? await localizeContentImages(currentIssueData.data.body, worktreeInfo.worktreePath, correlatedLogger, githubToken.token)
        : undefined;

    const localizedComments = await Promise.all(
        issueComments.map(async (comment) => ({
            ...comment,
            body: comment.body ? await localizeContentImages(comment.body, worktreeInfo.worktreePath, correlatedLogger, githubToken.token) : comment.body
        }))
    );

    // Build prompt for the agent
    const prompt = generateClaudePrompt(
        { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
        worktreeInfo.branchName,
        modelName,
        {
            title: currentIssueData.data.title,
            body: localizedBody,
            comments: localizedComments,
            labels: currentIssueData.data.labels,
            created_at: currentIssueData.data.created_at,
            user: currentIssueData.data.user
        }
    );

    // Execute task via agent abstraction
    const agentResult = await agent.executeTask({
        worktreePath: worktreeInfo.worktreePath,
        issueRef: { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
        prompt,
        model: modelName,
        githubToken: githubToken.token,
        branchName: worktreeInfo.branchName,
        onSessionId: createSessionIdCallback(taskId, issueRef, { modelName, stateManager, correlatedLogger, redisClient }),
        onContainerId: createContainerIdCallback(taskId, stateManager, correlatedLogger)
    });

    // Convert to ClaudeCodeResponse for backwards compatibility
    const claudeResult = agentResultToClaudeResponse(agentResult);

    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agent.config.type} agent execution completed`,
        claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
        historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model }
    });

    await recordLLMMetrics(toClaudeResult(agentResult), { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName }, { jobType: 'issue', correlationId, taskId });

    correlatedLogger.info({
        agentAlias,
        success: agentResult.success,
        executionTimeMs: agentResult.executionTimeMs,
        modelUsed: agentResult.modelUsed
    }, 'Agent execution completed');

    return claudeResult;
}

export async function processGitHubIssueJob(job: Job<IssueJobData>): Promise<JobResult> {
    logger.debug({ jobId: job.id, isChildJob: job.data.isChildJob, hasModelName: !!job.data.modelName }, 'Checking if job should be dispatched');

    if (!job.data.isChildJob) {
        logger.info({ jobId: job.id }, 'Running as matrix dispatcher');
        return await handleDispatch(job);
    }

    const context = await initializeJobContext(job);
    const { jobId, jobName, issueRef, correlationId, correlatedLogger, stateManager, agentAlias, modelName, taskId, AI_PROCESSING_TAG, AI_DONE_TAG, PR_LABEL } = context;

    await addModelSpecificDelay(modelName);

    try {
        await stateManager.createTaskState(taskId, { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName } as IssueRef, correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create task state, continuing anyway');
    }

    correlatedLogger.info({ jobId, jobName, taskId, issueNumber: issueRef.number, repo: `${issueRef.repoOwner}/${issueRef.repoName}` }, 'Processing job started');

    const octokit = await getAuthenticatedClient(context);

    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    let claudeResult: ClaudeCodeResponse | null = null;
    let postProcessingResult: PostProcessingResult | null = null;
    let commitResult: CommitResult | null = null;

    try {
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting issue processing' });

        const currentIssueData: CurrentIssueData = issueRef.issuePayload ? { data: issueRef.issuePayload as CurrentIssueData['data'] } :
            await withRetry(() => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
            }), { ...retryConfigs.githubApi, correlationId }, `get_issue_${issueRef.number}`) as unknown as CurrentIssueData;

        const currentLabels = currentIssueData.data.labels.map(label => label.name);
        const labelCheck = checkLabelConditions(currentLabels, context);
        if (labelCheck.skip) return { status: 'skipped', reason: labelCheck.reason, issueNumber: issueRef.number };

        if (!currentLabels.includes(AI_PROCESSING_TAG)) {
            await safeAddLabel({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, AI_PROCESSING_TAG);
        }

        const updatedIssueRef: IssueJobData = { ...issueRef, title: `New Issue: ${currentIssueData.data.title}`, subtitle: `Preparing a PR for issue #${issueRef.number}` };
        await updateTaskTitleInStorage(taskId, updatedIssueRef, stateManager, correlatedLogger);
        await job.updateProgress(25);

        const repoValidation: RepoValidation = issueRef.repoPayload ? { isValid: true, repoData: issueRef.repoPayload as unknown as RepoValidation['repoData'] } : await validateRepositoryInfo({ repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, number: issueRef.number }, octokit, correlationId);
        const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;
        const repoUrl = getRepoUrl(issueRef);

        try {
            await ensureGitRepository(correlatedLogger);
            localRepoPath = await ensureRepoCloned(repoUrl, issueRef.repoOwner, issueRef.repoName, githubToken.token);
            await job.updateProgress(50);

            worktreeInfo = await createWorktreeForIssue(localRepoPath, { issueId: issueRef.number, issueTitle: currentIssueData.data.title, owner: issueRef.repoOwner, repoName: issueRef.repoName }, { baseBranch: issueRef.baseBranch || null, octokit, modelName });
            await job.updateProgress(75);

            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
                body: `🤖 AI processing has started for this issue using **${agentAlias}** agent with **${modelName}** model.\n\nI'll analyze the problem and work on a solution. This may take a few minutes.\n\n**Processing Details:**\n- Agent: \`${agentAlias}\`\n- Model: \`${modelName}\`\n- Branch: \`${worktreeInfo.branchName}\`\n- Base Branch: \`${issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main'}\`\n- Worktree: \`${worktreeInfo.worktreePath.split('/').pop()}\``,
            });

            await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token });
            await job.updateProgress(80);

            const issueComments = await fetchIssueComments(octokit, issueRef, correlatedLogger);
            claudeResult = await executeAgentAndRecordMetrics({ octokit, worktreeInfo, issueRef, githubToken, currentIssueData, issueComments }, context);

            const postProcessResult = await performPostProcessing({ octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger });
            commitResult = postProcessResult.commitResult;
            postProcessingResult = postProcessResult.postProcessingResult;
            await job.updateProgress(95);

        } finally {
            await performFinalValidation({ claudeResult: claudeResult || undefined, worktreeInfo, issueRef, octokit, postProcessingResult, repoValidation, githubToken, modelName, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath: localRepoPath || '', jobId, correlationId, correlatedLogger, PR_LABEL, repoUrl });
        }

        await job.updateProgress(100);
        await markTaskComplete({ stateManager, taskId, claudeResult, postProcessingResult, commitResult, correlatedLogger });
        return buildFinalResult(issueRef, localRepoPath || '', { worktreeInfo, claudeResult, postProcessingResult, commitResult });

    } catch (error) {
        if (error instanceof UsageLimitError) {
            await handleUsageLimitError(error, job, issueRef, { octokit, correlatedLogger, stateManager, taskId });
        } else {
            await handleGenericError(error as Error, job, issueRef, { octokit, claudeResult, worktreeInfo, correlatedLogger, stateManager, taskId, AI_PROCESSING_TAG });
            throw error;
        }
        return { status: 'error', error: (error as Error).message };
    }
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

export { processGitHubIssueJob as default };
