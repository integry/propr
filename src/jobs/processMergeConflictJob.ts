import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { ensureRepoCloned, createWorktreeFromExistingBranch, getRepoUrl, commitChanges, pushBranch, mergeBaseIntoBranch } from '@propr/core';
import type { WorktreeInfo, MergeResult } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { createLogFiles } from '@propr/core';
import { UsageLimitError, AgentRegistry } from '@propr/core';
import type { ClaudeCodeResponse } from '@propr/core';
import { recordLLMMetrics } from '@propr/core';
import type { MergeConflictJobData, JobResult } from '@propr/core';
import { Redis } from 'ioredis';
import { getDefaultModel, loadSettings, db } from '@propr/core';
import { cleanupWorktree } from '@propr/core';
import {
    createSessionIdCallbackForPR,
    createContainerIdCallbackForPR,
} from './prCommentJobHelpers.js';
import {
    toClaudeResult,
    agentResultToClaudeResponse,
} from './prCommentJobUtils.js';
import {
    buildConflictResolutionPrompt,
    buildMergeConflictCommitMessage,
    buildMergeConflictComment,
} from './mergeConflictHelpers.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

interface GitHubToken { token: string }

/**
 * Resolves the default agent and model from settings, with fallback to registry default.
 */
async function resolveDefaultAgentAndModel(
    registry: AgentRegistry,
    correlatedLogger: Logger
): Promise<{ resolvedAlias: string; resolvedModel: string }> {
    try {
        const settings = await loadSettings();
        if (settings.default_agent_alias) {
            const configuredAgent = registry.getAgentByAlias(settings.default_agent_alias as string);
            if (configuredAgent && configuredAgent.config.enabled) {
                const resolvedAlias = settings.default_agent_alias as string;
                const resolvedModel = configuredAgent.config.defaultModel || DEFAULT_MODEL_NAME;
                return { resolvedAlias, resolvedModel };
            }
        }
    } catch (settingsError) {
        correlatedLogger.debug({ error: (settingsError as Error).message }, 'Failed to load default agent from settings');
    }

    const defaultAgent = registry.getDefaultAgent();
    const resolvedAlias = defaultAgent?.config.alias || 'claude';
    const resolvedModel = defaultAgent?.config.defaultModel || DEFAULT_MODEL_NAME;
    return { resolvedAlias, resolvedModel };
}

async function handleCleanMerge(options: {
    worktreeInfo: WorktreeInfo;
    branchName: string;
    baseBranch: string;
    pullRequestNumber: number;
    repoUrl: string;
    githubToken: GitHubToken;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    repoOwner: string;
    repoName: string;
    startingCommentId: number;
    stateManager: WorkerStateManager;
    taskId: string;
    correlatedLogger: Logger;
}): Promise<JobResult> {
    const { worktreeInfo, branchName, baseBranch, pullRequestNumber, repoUrl, githubToken,
        octokit, repoOwner, repoName, startingCommentId, stateManager, taskId, correlatedLogger } = options;

    // The merge was clean - commit and push
    const commitMessage = buildMergeConflictCommitMessage({
        baseBranch,
        headBranch: branchName,
        pullRequestNumber,
        wasCleanMerge: true,
    });

    const commitResult = await commitChanges(worktreeInfo.worktreePath, commitMessage, { name: 'Claude Code', email: 'claude-code@anthropic.com' }, { issueNumber: pullRequestNumber, issueTitle: 'Merge base branch' });

    if (commitResult) {
        await pushBranch(worktreeInfo.worktreePath, branchName, { repoUrl, authToken: githubToken.token });
    }

    // Update the starting comment with clean merge result
    const comment = buildMergeConflictComment({
        wasCleanMerge: true,
        commitHash: commitResult?.commitHash,
        baseBranch,
        headBranch: branchName,
    });

    await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: repoOwner, repo: repoName, comment_id: startingCommentId, body: comment,
    });

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Clean merge completed successfully', commitHash: commitResult?.commitHash,
    });

    if (commitResult?.commitHash) {
        try {
            await db('tasks').where({ task_id: taskId }).update({ commit_hash: commitResult.commitHash });
        } catch (dbError) {
            correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database');
        }
    }

    correlatedLogger.info({ pullRequestNumber, commitHash: commitResult?.commitHash, baseBranch }, 'Clean merge completed successfully');

    return { status: 'complete', commit: commitResult?.commitHash, pullRequestNumber, mergeType: 'clean' };
}

async function handleConflictMerge(options: {
    mergeResult: MergeResult;
    worktreeInfo: WorktreeInfo;
    branchName: string;
    baseBranch: string;
    pullRequestNumber: number;
    repoUrl: string;
    repoOwner: string;
    repoName: string;
    githubToken: GitHubToken;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    startingCommentId: number;
    stateManager: WorkerStateManager;
    taskId: string;
    correlationId: string;
    correlatedLogger: Logger;
}): Promise<JobResult> {
    const { mergeResult, worktreeInfo, branchName, baseBranch, pullRequestNumber, repoUrl,
        repoOwner, repoName, githubToken, octokit, startingCommentId,
        stateManager, taskId, correlationId, correlatedLogger } = options;

    const conflictedFiles = mergeResult.conflictedFiles || [];

    // Build the conflict resolution prompt
    const prompt = buildConflictResolutionPrompt({
        pullRequestNumber,
        baseBranch,
        headBranch: branchName,
        conflictedFiles,
        worktreeInfo,
        repoOwner,
        repoName,
    });

    // Resolve agent
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
    const agent = registry.getAgentByAlias(resolvedAlias);

    if (!agent) {
        throw new Error(`Agent not found for alias: ${resolvedAlias}`);
    }

    correlatedLogger.info({
        agentAlias: resolvedAlias,
        agentType: agent.config.type,
        model: resolvedModel,
        pullRequestNumber,
        conflictedFiles,
    }, 'Executing merge conflict resolution with agent');

    const agentResult = await agent.executeTask({
        worktreePath: worktreeInfo.worktreePath,
        issueRef: { number: pullRequestNumber, repoOwner, repoName },
        prompt,
        model: resolvedModel,
        githubToken: githubToken.token,
        branchName,
        onSessionId: createSessionIdCallbackForPR(taskId, { pullRequestNumber, repoOwner, repoName }, { llm: resolvedModel, stateManager, correlatedLogger, redisClient }),
        onContainerId: createContainerIdCallbackForPR(taskId, stateManager),
    });

    const claudeResult: ClaudeCodeResponse = agentResultToClaudeResponse(agentResult);

    await recordLLMMetrics(toClaudeResult(claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'merge_conflict', correlationId, taskId });
    await createLogFiles(claudeResult as unknown, { number: pullRequestNumber, repoOwner, repoName });

    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agent.config.type} agent execution completed for merge conflict resolution`,
        claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
        historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model },
    });

    if (!claudeResult.success) {
        throw new Error(`Agent execution failed during conflict resolution: ${claudeResult.error || 'Unknown error'}`);
    }

    // Commit resolved conflicts
    const commitMessage = buildMergeConflictCommitMessage({
        baseBranch,
        headBranch: branchName,
        pullRequestNumber,
        conflictedFiles,
        model: claudeResult.model || resolvedModel,
        wasCleanMerge: false,
    });

    const commitResult = await commitChanges(worktreeInfo.worktreePath, commitMessage, { name: 'Claude Code', email: 'claude-code@anthropic.com' }, { issueNumber: pullRequestNumber, issueTitle: 'Resolve merge conflicts' });

    if (commitResult) {
        await pushBranch(worktreeInfo.worktreePath, branchName, { repoUrl, authToken: githubToken.token });
    }

    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const taskUrl = `${webUiUrl}/tasks/${taskId}`;

    // Update the starting comment with resolution result
    const comment = buildMergeConflictComment({
        wasCleanMerge: false,
        commitHash: commitResult?.commitHash,
        baseBranch,
        headBranch: branchName,
        conflictedFiles,
        model: claudeResult.model || resolvedModel,
        executionTimeMs: claudeResult.executionTime,
        taskUrl,
    });

    await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: repoOwner, repo: repoName, comment_id: startingCommentId, body: comment,
    });

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Merge conflict resolution completed successfully', commitHash: commitResult?.commitHash,
    });

    if (commitResult?.commitHash) {
        try {
            await db('tasks').where({ task_id: taskId }).update({ commit_hash: commitResult.commitHash });
        } catch (dbError) {
            correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database');
        }
    }

    correlatedLogger.info({
        pullRequestNumber,
        commitHash: commitResult?.commitHash,
        baseBranch,
        conflictedFiles,
        model: claudeResult.model || resolvedModel,
    }, 'Merge conflict resolution completed successfully');

    return {
        status: 'complete',
        commit: commitResult?.commitHash,
        pullRequestNumber,
        mergeType: 'conflict_resolved',
        claudeResult: { success: claudeResult.success },
    };
}

/**
 * Processes a merge conflict resolution job.
 * This job:
 * 1. Creates a worktree from the PR head branch
 * 2. Merges the base branch into it
 * 3. If clean merge: commits and pushes
 * 4. If conflicts: invokes the AI agent to resolve them
 * 5. Posts GitHub comments about the outcome
 */
export async function processMergeConflictJob(job: Job<MergeConflictJobData>): Promise<JobResult> {
    const { pullRequestNumber, repoOwner, repoName, headBranch, baseBranch, headSha, baseSha, triggerSource, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);

    correlatedLogger.info({
        pullRequestNumber, headBranch, baseBranch, headSha, baseSha, triggerSource,
    }, 'Processing merge conflict resolution job');

    const taskId = job.id || `merge-conflict-${pullRequestNumber}-${Date.now()}`;
    const stateManager = getStateManager();
    const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;

    // Acquire lock
    const lockResult = await redisClient.set(lockKey, correlationId, 'EX', 3600, 'NX');
    if (lockResult !== 'OK') {
        const currentLock = await redisClient.get(lockKey);
        if (currentLock !== correlationId) {
            correlatedLogger.info({ lockOwner: currentLock }, 'PR is currently being processed by another job. Rescheduling merge conflict job.');
            const { issueQueue } = await import('@propr/core');
            await issueQueue.add(job.name, job.data, { delay: 10000 });
            return { status: 'rescheduled', reason: 'pr_locked_by_other_job' };
        }
    }

    // Resolve model name for task state
    let modelName = DEFAULT_MODEL_NAME;
    try {
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const defaultAgent = registry.getDefaultAgent();
        if (defaultAgent?.config.defaultModel) {
            modelName = defaultAgent.config.defaultModel;
        }
    } catch {
        // Keep DEFAULT_MODEL_NAME
    }

    try {
        await stateManager.createTaskState(taskId, { number: pullRequestNumber, repoOwner, repoName, modelName } as unknown as Parameters<typeof stateManager.createTaskState>[1], correlationId);
    } catch (stateError) {
        correlatedLogger.warn({ taskId, error: (stateError as Error).message }, 'Failed to create initial task state');
    }

    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null = null;
    let startingCommentId: number | undefined;

    try {
        octokit = await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
        const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        // Post starting comment
        const startingComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: `🔀 **Auto-resolving merge conflicts** — merging \`${baseBranch}\` into \`${headBranch}\`\n\nThis is a system-triggered action to keep the PR branch up to date.`,
        });
        startingCommentId = (startingComment as { data: { id: number } }).data.id;

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting merge conflict resolution' });
        await ensureGitRepository(correlatedLogger);
        localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken.token });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, headBranch, {
            worktreeDirName: `pr-${pullRequestNumber}-merge-${timestamp}`,
            owner: repoOwner,
            repoName,
        });

        correlatedLogger.info({ worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName }, 'Created worktree for merge conflict resolution');

        // Perform the merge
        const mergeResult = await mergeBaseIntoBranch(worktreeInfo.worktreePath, baseBranch);

        if (mergeResult.outcome === 'failed') {
            throw new Error(`Merge failed: ${mergeResult.error}`);
        }

        if (mergeResult.outcome === 'clean') {
            return await handleCleanMerge({
                worktreeInfo, branchName: headBranch, baseBranch, pullRequestNumber,
                repoUrl, githubToken, octokit, repoOwner, repoName,
                startingCommentId, stateManager, taskId, correlatedLogger,
            });
        }

        // Conflicts found - invoke agent
        return await handleConflictMerge({
            mergeResult, worktreeInfo, branchName: headBranch, baseBranch, pullRequestNumber,
            repoUrl, repoOwner, repoName, githubToken, octokit, startingCommentId,
            stateManager, taskId, correlationId, correlatedLogger,
        });

    } catch (error) {
        const errorMessage = (error as Error).message || 'Unknown error';
        correlatedLogger.error({ pullRequestNumber, error: errorMessage }, 'Merge conflict resolution job failed');

        await stateManager.updateTaskState(taskId, TaskStates.FAILED, {
            reason: 'Merge conflict resolution failed', error: { message: errorMessage },
        });

        // Update the starting comment with error info
        if (octokit && startingCommentId) {
            try {
                await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                    owner: repoOwner, repo: repoName, comment_id: startingCommentId,
                    body: `❌ **Failed to resolve merge conflicts** from \`${baseBranch}\` into \`${headBranch}\`\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\n---\n_System-triggered merge conflict resolution_`,
                });
            } catch (commentError) {
                correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post error comment');
            }
        }

        if (!(error instanceof UsageLimitError)) throw error;
        return { status: 'failed', reason: 'merge_conflict_resolution_failed' };
    } finally {
        // Release lock
        const lockOwner = await redisClient.get(lockKey);
        if (lockOwner === correlationId) {
            await redisClient.del(lockKey);
        }

        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, { deleteBranch: false, success: true });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
            }
        }
    }
}
