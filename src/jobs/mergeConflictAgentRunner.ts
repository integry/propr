import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    AgentRegistry,
    TaskStates,
    commitChanges,
    createLogFiles,
    db,
    getAuthenticatedOctokit,
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
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import type { GitHubToken } from './githubTypes.js';

async function buildMergeCompletionHistoryMetadata(options: {
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    baseBranch: string;
    headBranch: string;
    model: string;
    commitHash: string;
    correlatedLogger: Logger;
}): Promise<Record<string, unknown>> {
    let previousHistoryMetadata: Record<string, unknown> = {};

    try {
        const state = await options.stateManager.getTaskState(options.taskId);
        previousHistoryMetadata = [...(state?.history || [])]
            .reverse()
            .find(entry => entry.metadata && Object.keys(entry.metadata).length > 0)
            ?.metadata || {};
        const issueRef = state?.issueRef as { title?: unknown; subtitle?: unknown; issueNumber?: unknown } | undefined;
        previousHistoryMetadata = {
            ...previousHistoryMetadata,
            ...(typeof issueRef?.title === 'string' && { title: issueRef.title }),
            ...(typeof issueRef?.subtitle === 'string' && { subtitle: issueRef.subtitle }),
            ...(typeof issueRef?.issueNumber === 'number' && { issueNumber: issueRef.issueNumber }),
        };
    } catch (stateError) {
        options.correlatedLogger.warn({ taskId: options.taskId, error: (stateError as Error).message }, 'Failed to load merge task metadata for completion history');
    }

    return {
        ...previousHistoryMetadata,
        commandMode: 'merge',
        pullRequestNumber: options.pullRequestNumber,
        baseBranch: options.baseBranch,
        headBranch: options.headBranch,
        model: options.model,
        commitHash: options.commitHash,
    };
}

async function verifyNoConflictMarkers(worktreeInfo: WorktreeInfo, pullRequestNumber: number, correlatedLogger: Logger): Promise<void> {
    const { execFileSync } = await import('child_process');
    const { readFileSync, statSync } = await import('fs');
    const { join } = await import('path');

    try {
        const trackedAndUntracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
            cwd: worktreeInfo.worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
        });
        const ignored = execFileSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], {
            cwd: worktreeInfo.worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
        });
        const filePaths = new Set(`${trackedAndUntracked}\0${ignored}`.split('\0').filter(Boolean));
        const markerLines: string[] = [];

        for (const filePath of filePaths) {
            const absolutePath = join(worktreeInfo.worktreePath, filePath);
            try {
                if (!statSync(absolutePath).isFile()) continue;
                const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
                lines.forEach((line, index) => {
                    if (/^(<<<<<<<|=======|>>>>>>>)($|\s)/.test(line)) {
                        markerLines.push(`${filePath}:${index + 1}:${line}`);
                    }
                });
            } catch {
                // Ignore files that disappear or cannot be decoded while scanning.
            }
        }

        if (markerLines.length > 0) {
            correlatedLogger.error({
                pullRequestNumber,
                remainingMarkers: markerLines.length,
                firstFewMarkers: markerLines.slice(0, 5)
            }, 'Conflict markers still present after agent execution');
            throw new Error(`Agent failed to resolve all merge conflicts. ${markerLines.length} conflict marker(s) still present in files.`);
        }
    } catch (grepError) {
        if ((grepError as { status?: number }).status === 1) return;
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
        historyMetadata: await buildMergeCompletionHistoryMetadata({
            stateManager, taskId, pullRequestNumber, baseBranch, headBranch: branchName,
            model: claudeResult.model || resolvedModel, commitHash: finalCommitHash, correlatedLogger,
        }),
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
