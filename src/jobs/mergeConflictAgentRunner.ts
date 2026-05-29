import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    AgentRegistry,
    TaskStates,
    commitChanges,
    createLogFiles,
    db,
    getAuthenticatedOctokit,
    getDefaultModel,
    loadSettings,
    NoDefaultModelConfiguredError,
    pushBranch,
    recordLLMMetrics,
} from '@propr/core';
import type { ClaudeCodeResponse, JobResult, WorkerStateManager, WorktreeInfo } from '@propr/core';
import { createContainerIdCallbackForPR, createSessionIdCallbackForPR } from './prCommentJobHelpers.js';
import { agentResultToClaudeResponse, toClaudeResult } from './prCommentJobUtils.js';
import {
    buildConflictResolutionPrompt,
    buildMergeConflictComment,
    buildMergeConflictCommitMessage,
} from './mergeConflictHelpers.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;

interface GitHubToken { token: string }

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
                if (!resolvedModel) throw new NoDefaultModelConfiguredError();
                return { resolvedAlias, resolvedModel };
            }
        }
    } catch (settingsError) {
        if (settingsError instanceof NoDefaultModelConfiguredError) throw settingsError;
        correlatedLogger.debug({ error: (settingsError as Error).message }, 'Failed to load default agent from settings');
    }

    const defaultAgent = registry.getDefaultAgent();
    const resolvedAlias = defaultAgent?.config.alias || 'claude';
    const resolvedModel = defaultAgent?.config.defaultModel || DEFAULT_MODEL_NAME;
    if (!resolvedModel) throw new NoDefaultModelConfiguredError();
    return { resolvedAlias, resolvedModel };
}

async function verifyNoConflictMarkers(worktreeInfo: WorktreeInfo, pullRequestNumber: number, correlatedLogger: Logger): Promise<void> {
    const { execSync } = await import('child_process');
    try {
        const grepResult = execSync(
            `grep -rn "^<<<<<<<\\|^=======\\|^>>>>>>>" --include="*" . 2>/dev/null || true`,
            { cwd: worktreeInfo.worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();

        if (grepResult) {
            const markerLines = grepResult.split('\n').filter(line => line.length > 0);
            correlatedLogger.error({
                pullRequestNumber,
                remainingMarkers: markerLines.length,
                firstFewMarkers: markerLines.slice(0, 5)
            }, 'Conflict markers still present after agent execution');
            throw new Error(`Agent failed to resolve all merge conflicts. ${markerLines.length} conflict marker(s) still present in files.`);
        }
    } catch (grepError) {
        if ((grepError as Error).message?.includes('Agent failed to resolve')) throw grepError;
        correlatedLogger.warn({ error: (grepError as Error).message }, 'Failed to verify conflict markers, continuing');
    }
}

export async function handleMergeWithAgent(options: {
    conflictedFiles?: string[];
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
    redisClient: Redis;
}): Promise<JobResult> {
    const { conflictedFiles, worktreeInfo, branchName, baseBranch, pullRequestNumber, repoUrl,
        repoOwner, repoName, githubToken, octokit, startingCommentId,
        stateManager, taskId, correlationId, correlatedLogger, redisClient } = options;

    const prompt = buildConflictResolutionPrompt({
        pullRequestNumber, baseBranch, headBranch: branchName, conflictedFiles, worktreeInfo, repoOwner, repoName,
    });
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
    const agent = registry.getAgentByAlias(resolvedAlias);
    if (!agent) throw new Error(`Agent not found for alias: ${resolvedAlias}`);

    correlatedLogger.info({
        agentAlias: resolvedAlias, agentType: agent.config.type, model: resolvedModel, pullRequestNumber, conflictedFiles,
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
        taskId,
        prNumber: pullRequestNumber,
    });

    const claudeResult: ClaudeCodeResponse = agentResultToClaudeResponse(agentResult);
    await recordLLMMetrics(toClaudeResult(claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'merge_conflict', correlationId, taskId });
    await createLogFiles(claudeResult as unknown, { number: pullRequestNumber, repoOwner, repoName });
    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agent.config.type} agent execution completed for merge conflict resolution`,
        claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
        historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model },
    });
    if (!claudeResult.success) throw new Error(`Agent execution failed during conflict resolution: ${claudeResult.error || 'Unknown error'}`);

    await verifyNoConflictMarkers(worktreeInfo, pullRequestNumber, correlatedLogger);
    const commitMessage = buildMergeConflictCommitMessage({
        baseBranch, headBranch: branchName, pullRequestNumber, conflictedFiles,
        model: claudeResult.model || resolvedModel, wasCleanMerge: false,
    });
    const commitResult = await commitChanges(worktreeInfo.worktreePath, commitMessage, { name: 'Claude Code', email: 'claude-code@anthropic.com' }, { issueNumber: pullRequestNumber, issueTitle: 'Resolve merge conflicts' });
    await pushBranch(worktreeInfo.worktreePath, branchName, { repoUrl, authToken: githubToken.token });

    const { simpleGit } = await import('simple-git');
    const finalCommitHash = commitResult?.commitHash || (await simpleGit({ baseDir: worktreeInfo.worktreePath }).revparse(['HEAD'])).trim();
    const taskUrl = `${process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev'}/tasks/${taskId}`;
    const comment = buildMergeConflictComment({
        wasCleanMerge: !conflictedFiles || conflictedFiles.length === 0,
        commitHash: finalCommitHash, baseBranch, headBranch: branchName, conflictedFiles,
        resolutionSummary: claudeResult.summary, model: claudeResult.model || resolvedModel,
        executionTimeMs: claudeResult.executionTime, taskUrl,
    });

    await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: repoOwner, repo: repoName, comment_id: startingCommentId, body: comment,
    });
    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Merge conflict resolution completed successfully', commitHash: finalCommitHash,
    });
    try {
        await db('tasks').where({ task_id: taskId }).update({ commit_hash: finalCommitHash });
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database');
    }

    correlatedLogger.info({
        pullRequestNumber, commitHash: finalCommitHash, baseBranch, conflictedFiles, model: claudeResult.model || resolvedModel,
    }, 'Merge conflict resolution completed successfully');
    return {
        status: 'complete',
        commit: finalCommitHash,
        pullRequestNumber,
        mergeType: conflictedFiles && conflictedFiles.length > 0 ? 'conflict_resolved' : 'clean',
        claudeResult: { success: claudeResult.success },
    };
}
