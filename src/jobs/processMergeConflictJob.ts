import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import type { WorkerStateManager } from '@propr/core';
import { ensureRepoCloned, createWorktreeFromExistingBranch, getRepoUrl, commitChanges, pushBranch, mergeBaseIntoBranch } from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { createLogFiles } from '@propr/core';
import { UsageLimitError, AgentRegistry } from '@propr/core';
import type { ClaudeCodeResponse } from '@propr/core';
import { recordLLMMetrics } from '@propr/core';
import type { MergeConflictJobData, JobResult } from '@propr/core';
import { Redis } from 'ioredis';
import { getDefaultModel, loadSettings, db, NoDefaultModelConfiguredError } from '@propr/core';
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

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;

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
                if (!resolvedModel) {
                    throw new NoDefaultModelConfiguredError();
                }
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
    if (!resolvedModel) {
        throw new NoDefaultModelConfiguredError();
    }
    return { resolvedAlias, resolvedModel };
}

async function handleMergeWithAgent(options: {
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
}): Promise<JobResult> {
    const { conflictedFiles, worktreeInfo, branchName, baseBranch, pullRequestNumber, repoUrl,
        repoOwner, repoName, githubToken, octokit, startingCommentId,
        stateManager, taskId, correlationId, correlatedLogger } = options;

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

    // Verify no conflict markers remain in the worktree before committing
    const { execSync } = await import('child_process');
    try {
        // Search for conflict markers in all files (excluding .git directory)
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
        // If the error is from our throw above, re-throw it
        if ((grepError as Error).message?.includes('Agent failed to resolve')) {
            throw grepError;
        }
        // Otherwise log and continue (grep command failed)
        correlatedLogger.warn({ error: (grepError as Error).message }, 'Failed to verify conflict markers, continuing');
    }

    // Commit any changes from conflict resolution (if agent made changes)
    const commitMessage = buildMergeConflictCommitMessage({
        baseBranch,
        headBranch: branchName,
        pullRequestNumber,
        conflictedFiles,
        model: claudeResult.model || resolvedModel,
        wasCleanMerge: false,
    });

    const commitResult = await commitChanges(worktreeInfo.worktreePath, commitMessage, { name: 'Claude Code', email: 'claude-code@anthropic.com' }, { issueNumber: pullRequestNumber, issueTitle: 'Resolve merge conflicts' });

    // Always push - even if no new commit was created by the agent,
    // git merge may have created a merge commit that needs pushing
    await pushBranch(worktreeInfo.worktreePath, branchName, { repoUrl, authToken: githubToken.token });

    // Get the current HEAD commit hash (either from our commit or the merge commit)
    const { simpleGit } = await import('simple-git');
    const git = simpleGit({ baseDir: worktreeInfo.worktreePath });
    const headCommit = await git.revparse(['HEAD']);
    const finalCommitHash = commitResult?.commitHash || headCommit.trim();

    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const taskUrl = `${webUiUrl}/tasks/${taskId}`;

    // Update the starting comment with resolution result
    const comment = buildMergeConflictComment({
        wasCleanMerge: !conflictedFiles || conflictedFiles.length === 0,
        commitHash: finalCommitHash,
        baseBranch,
        headBranch: branchName,
        conflictedFiles,
        resolutionSummary: claudeResult.summary,
        model: claudeResult.model || resolvedModel,
        executionTimeMs: claudeResult.executionTime,
        taskUrl,
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
        pullRequestNumber,
        commitHash: finalCommitHash,
        baseBranch,
        conflictedFiles,
        model: claudeResult.model || resolvedModel,
    }, 'Merge conflict resolution completed successfully');

    return {
        status: 'complete',
        commit: finalCommitHash,
        pullRequestNumber,
        mergeType: conflictedFiles && conflictedFiles.length > 0 ? 'conflict_resolved' : 'clean',
        claudeResult: { success: claudeResult.success },
    };
}

async function acquireMergeJobLock(
    lockKey: string,
    correlationId: string,
    job: Job<MergeConflictJobData>,
    correlatedLogger: Logger
): Promise<{ acquired: true } | { acquired: false; result: JobResult }> {
    const lockResult = await redisClient.set(lockKey, correlationId, 'EX', 3600, 'NX');
    if (lockResult !== 'OK') {
        const currentLock = await redisClient.get(lockKey);
        if (currentLock !== correlationId) {
            correlatedLogger.info({ lockOwner: currentLock }, 'PR is currently being processed by another job. Rescheduling merge conflict job.');
            const { issueQueue } = await import('@propr/core');
            await issueQueue.add(job.name, job.data, { delay: 10000 });
            return { acquired: false, result: { status: 'rescheduled', reason: 'pr_locked_by_other_job' } };
        }
    }
    return { acquired: true };
}

async function resolveModelForTask(): Promise<string> {
    try {
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const defaultAgent = registry.getDefaultAgent();
        if (defaultAgent?.config.defaultModel) {
            return defaultAgent.config.defaultModel;
        }
    } catch {
        // Keep default
    }
    if (!DEFAULT_MODEL_NAME) {
        throw new NoDefaultModelConfiguredError();
    }
    return DEFAULT_MODEL_NAME;
}

async function updateMergeTaskWithPRInfo(options: {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    headBranch: string;
    correlatedLogger: Logger;
}): Promise<void> {
    const { octokit, stateManager, taskId, pullRequestNumber, repoOwner, repoName, baseBranch, headBranch, correlatedLogger } = options;

    const graphqlResponse = await octokit.graphql<{
        repository: {
            pullRequest: {
                title: string;
                closingIssuesReferences: {
                    nodes: Array<{ number: number; title: string }>;
                };
            };
        };
    }>(`
        query($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                    title
                    closingIssuesReferences(first: 1) {
                        nodes {
                            number
                            title
                        }
                    }
                }
            }
        }
    `, { owner: repoOwner, repo: repoName, prNumber: pullRequestNumber });

    const prTitle = graphqlResponse.repository.pullRequest.title;
    const linkedIssues = graphqlResponse.repository.pullRequest.closingIssuesReferences.nodes;
    const linkedIssueNumber = linkedIssues.length > 0 ? linkedIssues[0].number : null;
    const taskTitle = `Merge: ${prTitle}`;
    const taskSubtitle = `Merging ${baseBranch} into ${headBranch}`;

    if (linkedIssueNumber) {
        correlatedLogger.info({ taskId, pullRequestNumber, linkedIssueNumber }, 'Found linked issue via GraphQL for merge task');
    }

    await db('tasks').where({ task_id: taskId }).update({
        pr_number: pullRequestNumber,
        initial_job_data: JSON.stringify({
            pullRequestNumber, repoOwner, repoName,
            title: taskTitle, subtitle: taskSubtitle,
            baseBranch, headBranch, type: 'merge_conflict',
            ...(linkedIssueNumber && { issueNumber: linkedIssueNumber }),
        }),
    });

    const state = await stateManager.getTaskState(taskId);
    if (state) {
        state.issueRef = {
            ...state.issueRef,
            pullRequestNumber, title: taskTitle, subtitle: taskSubtitle,
            ...(linkedIssueNumber && { issueNumber: linkedIssueNumber }),
        };
        await redisClient.setex(stateManager.getTaskKey(taskId), 7 * 24 * 3600, JSON.stringify(state));
    }

    correlatedLogger.info({ taskId, prTitle, taskTitle, linkedIssueNumber }, 'Updated merge task with PR title and linked issue');
}

async function handleMergeJobError(error: Error, options: {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    startingCommentId: number | undefined;
    stateManager: WorkerStateManager;
    taskId: string;
    repoOwner: string; repoName: string;
    baseBranch: string; headBranch: string;
    pullRequestNumber: number;
    correlatedLogger: Logger;
}): Promise<JobResult> {
    const { octokit, startingCommentId, stateManager, taskId, repoOwner, repoName, baseBranch, headBranch, pullRequestNumber, correlatedLogger } = options;
    const errorMessage = error.message || 'Unknown error';
    correlatedLogger.error({ pullRequestNumber, error: errorMessage }, 'Merge conflict resolution job failed');

    await stateManager.updateTaskState(taskId, TaskStates.FAILED, {
        reason: 'Merge conflict resolution failed', error: { message: errorMessage },
    });

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
}

/**
 * Processes a merge conflict resolution job.
 * This job:
 * 1. Creates a worktree from the PR head branch
 * 2. Merges the base branch into it (git leaves conflict markers if any)
 * 3. Always invokes the AI agent to verify/resolve the merge
 * 4. Commits and pushes the result
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

    const lockStatus = await acquireMergeJobLock(lockKey, correlationId, job, correlatedLogger);
    if (!lockStatus.acquired) return lockStatus.result;

    const modelName = await resolveModelForTask();

    try {
        await stateManager.createTaskState(taskId, {
            number: pullRequestNumber, repoOwner, repoName, modelName,
            type: 'pr_followup', pullRequestNumber,
        } as unknown as Parameters<typeof stateManager.createTaskState>[1], correlationId);
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

        const startingComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: `🔀 **Auto-resolving merge conflicts** — merging \`${baseBranch}\` into \`${headBranch}\`\n\nThis is a system-triggered action to keep the PR branch up to date.`,
        });
        startingCommentId = (startingComment as { data: { id: number } }).data.id;

        try {
            await updateMergeTaskWithPRInfo({ octokit, stateManager, taskId, pullRequestNumber, repoOwner, repoName, baseBranch, headBranch, correlatedLogger });
        } catch (prError) {
            correlatedLogger.warn({ taskId, error: (prError as Error).message }, 'Failed to fetch PR info for merge task');
        }

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Starting merge conflict resolution' });
        await ensureGitRepository(correlatedLogger);
        localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken.token });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, headBranch, {
            worktreeDirName: `pr-${pullRequestNumber}-merge-${timestamp}`,
            owner: repoOwner, repoName,
        });

        correlatedLogger.info({ worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName }, 'Created worktree for merge conflict resolution');

        const mergeResult = await mergeBaseIntoBranch(worktreeInfo.worktreePath, baseBranch);

        if (mergeResult.outcome === 'failed') {
            throw new Error(`Merge failed: ${mergeResult.error}`);
        }

        return await handleMergeWithAgent({
            conflictedFiles: mergeResult.conflictedFiles,
            worktreeInfo, branchName: headBranch, baseBranch,
            pullRequestNumber, repoUrl, repoOwner, repoName,
            githubToken, octokit, startingCommentId,
            stateManager, taskId, correlationId, correlatedLogger,
        });

    } catch (error) {
        return await handleMergeJobError(error as Error, {
            octokit, startingCommentId, stateManager, taskId,
            repoOwner, repoName, baseBranch, headBranch, pullRequestNumber, correlatedLogger,
        });
    } finally {
        const lockOwner = await redisClient.get(lockKey);
        if (lockOwner === correlationId) {
            await redisClient.del(lockKey);
        }

        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, { deleteBranch: false, success: true });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
            }
        }
    }
}
