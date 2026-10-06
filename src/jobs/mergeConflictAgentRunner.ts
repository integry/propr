import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    AgentRegistry,
    TaskStates,
    createLogFiles,
    db,
    getAuthenticatedOctokit,
    performConflictResolution,
    recordLLMMetrics,
} from '@propr/core';
import type { ClaudeCodeResponse, ConflictResolverContext, JobResult, MergeBaseIntoBranchOptions, WorkerStateManager, WorktreeInfo } from '@propr/core';
import { createContainerIdCallbackForPR, createSessionIdCallbackForPR } from './prCommentJobHelpers.js';
import type { PullRequestPublication } from './prPublication.js';
import { recordPushSalvageEvent } from './pushSalvageTimeline.js';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { agentResultToClaudeResponse, toClaudeResult } from './prCommentJobUtils.js';
import {
    buildConflictResolutionPrompt,
    getAgentFailureDetail,
    buildMergeConflictComment,
    buildMergeConflictCommitMessage,
} from './mergeConflictHelpers.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import type { GitHubToken } from './githubTypes.js';
import { buildMergeNotificationRecap } from './notificationRecap.js';

const MAX_CONFLICT_MARKER_SCAN_BYTES = 1024 * 1024;
async function buildMergeCompletionHistoryMetadata(options: {
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    baseBranch: string;
    headBranch: string;
    model: string;
    commitHash: string;
    conflictedFiles?: readonly string[];
    summary?: unknown;
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
        notificationRecap: buildMergeNotificationRecap({
            baseBranch: options.baseBranch,
            headBranch: options.headBranch,
            conflictedFiles: options.conflictedFiles,
            summary: options.summary,
        }),
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
        const filePaths = new Set(trackedAndUntracked.split('\0').filter(Boolean));
        const markerLines: string[] = [];

        for (const filePath of filePaths) {
            const absolutePath = join(worktreeInfo.worktreePath, filePath);
            try {
                const stats = statSync(absolutePath);
                if (!stats.isFile() || stats.size > MAX_CONFLICT_MARKER_SCAN_BYTES) continue;
                const buffer = readFileSync(absolutePath);
                if (buffer.includes(0)) continue;
                const lines = buffer.toString('utf8').split(/\r?\n/);
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
    /** Where the base branch is fetched from (the base repository for fork heads). */
    mergeOptions: MergeBaseIntoBranchOptions;
    /** Runs after the local merge and before the agent. */
    onMerged?: (context: ConflictResolverContext) => Promise<void>;
    worktreeInfo: WorktreeInfo;
    /** Owns the mutable destination and adopts an unpushable fork into a continuation. */
    publication: PullRequestPublication;
    baseBranch: string;
    pullRequestNumber: number;
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
    const { mergeOptions, onMerged, worktreeInfo, publication, baseBranch, pullRequestNumber,
        repoOwner, repoName, githubToken, octokit, startingCommentId,
        stateManager, taskId, correlationId, correlatedLogger, redisClient } = options;
    const branchName = publication.target.branchName;

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
    const agent = registry.getAgentByAlias(resolvedAlias);
    if (!agent) throw new Error(`Agent not found for alias: ${resolvedAlias}`);

    // The agent is only the resolver: performConflictResolution owns the merge,
    // marker verification, the merge commit and the push.
    const resolveConflicts = async ({ conflictedFiles }: ConflictResolverContext): Promise<ClaudeCodeResponse> => {
        const prompt = buildConflictResolutionPrompt({
            pullRequestNumber, baseBranch, headBranch: branchName, conflictedFiles, worktreeInfo, repoOwner, repoName,
        });
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
        if (!claudeResult.success) {
            throw new Error(`Agent execution failed during conflict resolution: ${getAgentFailureDetail(claudeResult)}`);
        }
        // Markers anywhere in the tree, not only in the files git reported.
        await verifyNoConflictMarkers(worktreeInfo, pullRequestNumber, correlatedLogger);
        return claudeResult;
    };

    const outcome = await performConflictResolution<ClaudeCodeResponse>({
        worktreePath: worktreeInfo.worktreePath,
        baseBranch,
        branchName,
        merge: mergeOptions,
        // /merge semantics: an agent verifies clean merges too.
        resolveCleanMerges: true,
        onMerged,
        resolveConflicts,
        author: AI_COMMIT_AUTHOR,
        commitMessage: ({ conflictedFiles, wasCleanMerge, resolverResult }) => buildMergeConflictCommitMessage({
            baseBranch, headBranch: branchName, pullRequestNumber, conflictedFiles,
            model: resolverResult?.model || resolvedModel, wasCleanMerge,
        }),
        // A final fork rejection can be stricter than the dry-run preflight (for example,
        // when this merge introduces workflow commits). Preserve this exact HEAD and adopt
        // it into a ProPR-owned continuation rather than rerunning conflict resolution.
        push: ({ worktreePath }) => publication.push(worktreePath, undefined, {
            // Rebasing replays individual commits and can drop the merge commit that proves
            // the fetched base was incorporated.
            rebaseOnNonFastForward: false,
            salvage: { taskId, onEvent: recordPushSalvageEvent(stateManager, taskId, correlatedLogger) },
        }),
    });

    if (outcome.status === 'unresolved') {
        throw new Error(`Agent failed to resolve all merge conflicts. ${outcome.remainingMarkers.length} conflict marker(s) still present in files.`);
    }
    if (outcome.status === 'head_moved') {
        throw new Error(`Pull request head moved from ${outcome.expectedHeadSha} to ${outcome.previousHeadSha} before the merge`);
    }
    const claudeResult = 'resolverResult' in outcome ? outcome.resolverResult : undefined;
    if (!claudeResult) throw new Error('Merge conflict resolution finished without running the agent');
    const conflictedFiles = outcome.conflictedFiles.length > 0 ? outcome.conflictedFiles : undefined;
    const wasCleanMerge = !conflictedFiles;
    const publishedCommitHash = outcome.headSha;
    const publishedBranchName = publication.target.branchName;
    const taskUrl = `${process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev'}/tasks/${encodeURIComponent(taskId)}`;
    let comment = buildMergeConflictComment({
        wasCleanMerge,
        commitHash: publishedCommitHash, baseBranch, headBranch: publishedBranchName, conflictedFiles,
        resolutionSummary: claudeResult.summary, model: claudeResult.model || resolvedModel,
        executionTimeMs: claudeResult.executionTime, taskUrl,
    });
    if (publication.status) comment += `\n\n${publication.status}`;

    await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: repoOwner, repo: repoName, comment_id: startingCommentId, body: comment,
    });
    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Merge conflict resolution completed successfully', commitHash: publishedCommitHash,
        historyMetadata: await buildMergeCompletionHistoryMetadata({
            stateManager, taskId, pullRequestNumber, baseBranch, headBranch: publishedBranchName,
            model: claudeResult.model || resolvedModel, commitHash: publishedCommitHash,
            conflictedFiles, summary: claudeResult.summary, correlatedLogger,
        }),
    });
    try {
        await db('tasks').where({ task_id: taskId }).update({ commit_hash: publishedCommitHash });
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database');
    }

    correlatedLogger.info({
        pullRequestNumber, commitHash: publishedCommitHash, baseBranch, conflictedFiles, model: claudeResult.model || resolvedModel,
    }, 'Merge conflict resolution completed successfully');
    return {
        status: 'complete',
        commit: publishedCommitHash,
        pullRequestNumber,
        mergeType: conflictedFiles && conflictedFiles.length > 0 ? 'conflict_resolved' : 'clean',
        claudeResult: { success: claudeResult.success },
    };
}
