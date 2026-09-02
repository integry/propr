import fs from 'node:fs';
import type { Job } from 'bullmq';
import {
    AgentRegistry,
    GOAL_CONTINUE_INPUT,
    TaskStates,
    buildGoalPolicyEnvironment,
    createWorktreeForIssue,
    db,
    ensureGitRepository,
    ensureRepoCloned,
    getAuthenticatedOctokit,
    getRepoUrl,
    getStateManager,
    logger,
    recordLLMMetrics,
    type AgentExecutionResult,
    type GoalJobData,
} from '@propr/core';
import { createContainerIdCallback } from './issueJobCallbacks.js';

interface GoalRow {
    goal_id: string;
    repository: string;
    objective: string;
    base_branch: string | null;
    branch_name: string | null;
    worktree_path: string | null;
    agent_id: string;
    agent_alias: string;
    requested_model: string;
    desired_state: 'running' | 'paused' | 'cancelled';
    result_state: 'completed' | 'failed' | 'cancelled' | null;
    current_task_id: string;
    session_id: string | null;
    conversation_id: string | null;
    run_generation: number;
    max_parallel_tasks: number | null;
    ultrafix: number | boolean | null;
    artifact_refs?: string | GoalArtifact[] | null;
    started_at: string | null;
}

const githubArtifactPattern = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(pull|issues)\/(\d+)/g;

type GoalArtifact = { type: 'pull_request' | 'issue'; number: number; url: string };

function discoverArtifacts(output: string): GoalArtifact[] {
    const artifacts = new Map<string, GoalArtifact>();
    for (const match of output.matchAll(githubArtifactPattern)) {
        artifacts.set(match[0], { type: match[1] === 'pull' ? 'pull_request' : 'issue', number: Number(match[2]), url: match[0] });
    }
    return [...artifacts.values()];
}

function isRecoverableInterruption(result: AgentExecutionResult): boolean {
    if (result.terminationReason) return true;
    if (result.exitCode != null && [125, 137, 143].includes(result.exitCode)) return true;
    return /(?:docker|container|socket hang up|ECONNRESET|ECONNREFUSED|SIGKILL|terminated|execution aborted)/i
        .test(result.error || '');
}

async function saveSession(options: { goalId: string; taskId: string; model: string; sessionId: string; conversationId?: string }): Promise<void> {
    const { goalId, taskId, model, sessionId, conversationId } = options;
    await db('goals').where({ goal_id: goalId }).update({
        session_id: sessionId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        updated_at: db.fn.now(),
    });
    const stateManager = getStateManager();
    const state = await stateManager.getTaskState(taskId);
    if (!state || state.state === TaskStates.CANCELLED || state.state === TaskStates.COMPLETED || state.state === TaskStates.FAILED) return;
    if (state.state === TaskStates.CLAUDE_EXECUTION) {
        await stateManager.updateHistoryMetadata(taskId, TaskStates.CLAUDE_EXECUTION, { sessionId, conversationId, model, executionMode: 'goal' });
    } else {
        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
            reason: 'Native goal execution started',
            claudeResult: { success: false, sessionId, conversationId },
            historyMetadata: { sessionId, conversationId, model, executionMode: 'goal' },
        });
    }
}

async function ensureGoalWorktree(goal: GoalRow, token: string): Promise<{ worktreePath: string; branchName: string }> {
    if (goal.worktree_path && goal.branch_name) {
        if (!fs.existsSync(goal.worktree_path)) {
            throw new Error('Saved goal worktree is missing; refusing to create a second goal worktree');
        }
        return { worktreePath: goal.worktree_path, branchName: goal.branch_name };
    }

    const [repoOwner, repoName] = goal.repository.split('/');
    await ensureGitRepository(logger as never);
    const localRepoPath = await ensureRepoCloned({
        repoUrl: getRepoUrl({ repoOwner, repoName }),
        owner: repoOwner,
        repoName,
        authToken: token,
        ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}),
    });
    const worktree = await createWorktreeForIssue(localRepoPath, {
        issueId: `goal-${goal.goal_id.slice(0, 8)}`,
        issueTitle: goal.objective,
        owner: repoOwner,
        repoName,
    }, { baseBranch: goal.base_branch, modelName: goal.requested_model });

    const updated = await db('goals')
        .where({ goal_id: goal.goal_id })
        .whereNull('worktree_path')
        .update({ worktree_path: worktree.worktreePath, branch_name: worktree.branchName, updated_at: db.fn.now() });
    if (updated === 0) {
        const winner = await db<GoalRow>('goals').where({ goal_id: goal.goal_id }).first();
        if (!winner?.worktree_path || !winner.branch_name) throw new Error('Goal worktree allocation was fenced by an incomplete record');
        return { worktreePath: winner.worktree_path, branchName: winner.branch_name };
    }
    return worktree;
}

function parseArtifacts(value: GoalRow['artifact_refs']): GoalArtifact[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try { return JSON.parse(value) as GoalArtifact[]; } catch { return []; }
}

async function saveResultMetadata(goal: GoalRow, result: AgentExecutionResult): Promise<GoalArtifact | undefined> {
    const artifactsByUrl = new Map(parseArtifacts(goal.artifact_refs).map(artifact => [artifact.url, artifact]));
    for (const artifact of discoverArtifacts(`${result.rawOutput || ''}\n${result.logs || ''}\n${result.summary || ''}`)) {
        artifactsByUrl.set(artifact.url, artifact);
    }
    const artifacts = [...artifactsByUrl.values()];
    const finalPr = artifacts.findLast(artifact => artifact.type === 'pull_request');
    await db('goals').where({ goal_id: goal.goal_id }).update({
        effective_model: result.modelUsed,
        ...(result.sessionId ? { session_id: result.sessionId } : {}),
        ...(result.conversationId ? { conversation_id: result.conversationId } : {}),
        ...(finalPr ? { final_pr_number: finalPr.number, final_pr_url: finalPr.url } : {}),
        artifact_refs: JSON.stringify(artifacts),
        updated_at: db.fn.now(),
    });
    return finalPr;
}

async function finalizeGoal(goal: GoalRow, result: AgentExecutionResult): Promise<void> {
    await db('goals').where({ goal_id: goal.goal_id }).update({
        result_state: result.success ? 'completed' : 'failed',
        completed_at: db.fn.now(),
        updated_at: db.fn.now(),
    });
}

// This runner deliberately keeps every lifecycle fence adjacent to the single
// provider execution so retries cannot bypass worktree/session ownership.
// eslint-disable-next-line complexity
export async function processGoalJob(job: Job<GoalJobData>) {
    const goal = await db<GoalRow>('goals').where({ goal_id: job.data.goalId }).first();
    if (!goal || goal.current_task_id !== job.data.taskId) return { status: 'skipped', reason: 'goal_not_found' };
    if (goal.result_state || goal.desired_state !== 'running' || goal.run_generation !== job.data.generation) {
        return { status: 'skipped', reason: 'goal_fence' };
    }
    if (goal.worktree_path && !goal.session_id && (job.attemptsMade > 0 || job.data.recovery)) {
        throw new Error('Goal execution stopped before its provider session was persisted; refusing to start a second native goal');
    }

    const stateManager = getStateManager();
    const [repoOwner, repoName] = goal.repository.split('/');
    let state = await stateManager.getTaskState(goal.current_task_id);
    if (!state) {
        state = await stateManager.createTaskState(goal.current_task_id, {
            number: 0,
            repoOwner,
            repoName,
            type: 'goal',
            modelName: goal.requested_model,
            agentAlias: goal.agent_alias,
            title: goal.objective,
            goalId: goal.goal_id,
        }, goal.goal_id);
    }
    await stateManager.updateTaskState(goal.current_task_id, TaskStates.PROCESSING, {
        ...(state.state === TaskStates.FAILED ? { isRetry: true } : {}),
        reason: goal.session_id ? 'Resuming native goal session' : 'Preparing native goal session',
        historyMetadata: { executionMode: 'goal', generation: goal.run_generation },
    });

    const octokit = await getAuthenticatedOctokit();
    const githubToken = await octokit.auth({ type: 'installation' }) as { token: string };
    const worktree = await ensureGoalWorktree(goal, githubToken.token);

    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentById(goal.agent_id) || registry.getAgentByAlias(goal.agent_alias);
    if (!agent?.goalCapable) throw new Error(`Agent ${goal.agent_alias} has no native goal execution path`);
    const capability = (await registry.getGoalCapabilities()).find(item => item.agentId === agent.config.id);
    if (!capability?.goalCapable) {
        throw new Error(capability?.reason || `Pinned ${goal.agent_alias} CLI does not support native /goal`);
    }

    const beforeExecution = await db<GoalRow>('goals').where({ goal_id: goal.goal_id }).first();
    if (!beforeExecution || beforeExecution.desired_state !== 'running' || beforeExecution.run_generation !== job.data.generation) {
        await stateManager.updateTaskState(goal.current_task_id, TaskStates.PROCESSING, {
            reason: beforeExecution?.desired_state === 'paused' ? 'Goal paused before provider input' : 'Goal execution fenced before provider input',
        });
        return { status: 'skipped', reason: 'goal_input_fence' };
    }
    if (!beforeExecution.started_at) {
        const started = await db('goals').where({ goal_id: goal.goal_id, desired_state: 'running', run_generation: job.data.generation })
            .whereNull('started_at')
            .update({ started_at: db.fn.now(), updated_at: db.fn.now() });
        if (started !== 1) return { status: 'skipped', reason: 'goal_start_fence' };
    }

    // BullMQ retries the same durable job data. Once the early callback has
    // recorded a session, never replay the initial /goal command into it: a
    // retry is a continuation of that provider-owned goal.
    const input = goal.session_id && job.data.generation === 0
        ? GOAL_CONTINUE_INPUT
        : job.data.input || GOAL_CONTINUE_INPUT;
    const result = await agent.executeTask({
        worktreePath: worktree.worktreePath,
        issueRef: { number: 0, repoOwner, repoName },
        prompt: input,
        model: goal.requested_model,
        githubToken: githubToken.token,
        branchName: worktree.branchName,
        taskId: goal.current_task_id,
        executionMode: 'goal',
        resumeSessionId: goal.session_id ?? undefined,
        resumeConversationId: goal.conversation_id ?? undefined,
        environment: buildGoalPolicyEnvironment({
            maxParallelTasks: !goal.session_id ? goal.max_parallel_tasks : null,
            ultrafix: !goal.session_id && goal.ultrafix != null ? Boolean(goal.ultrafix) : null,
        }),
        onSessionId: (sessionId, conversationId) => saveSession({
            goalId: goal.goal_id, taskId: goal.current_task_id, model: goal.requested_model, sessionId, conversationId,
        }),
        onContainerId: createContainerIdCallback(goal.current_task_id, stateManager, logger as never, worktree.worktreePath),
    });

    await recordLLMMetrics({
        success: result.success,
        sessionId: result.sessionId,
        conversationId: result.conversationId,
        executionTime: result.executionTimeMs,
        model: result.modelUsed,
        conversationLog: result.conversationLog,
        tokenUsage: result.tokenUsage,
        error: result.error,
    }, { number: 0, repoOwner, repoName }, { jobType: 'issue', correlationId: goal.goal_id, taskId: goal.current_task_id });

    const finalPr = await saveResultMetadata(goal, result);

    const latest = await db<GoalRow>('goals').where({ goal_id: goal.goal_id }).first();
    if (!latest || latest.desired_state === 'cancelled') {
        await stateManager.markTaskCancelled(goal.current_task_id, 'user');
        return { status: 'cancelled' };
    }
    if (latest.desired_state === 'paused') {
        await stateManager.updateTaskState(goal.current_task_id, TaskStates.PROCESSING, { reason: 'Goal paused at provider boundary', historyMetadata: { paused: true } });
        return { status: 'paused' };
    }
    if (!result.success && isRecoverableInterruption(result)) {
        throw new Error(`Native goal execution was interrupted and will resume: ${result.error || result.terminationReason || `exit ${result.exitCode}`}`);
    }
    if (job.data.continuationKind === 'input') {
        await db('goals').where({ goal_id: goal.goal_id, desired_state: 'running' }).update({
            desired_state: 'paused', paused_at: db.fn.now(), updated_at: db.fn.now(),
        });
        await stateManager.updateTaskState(goal.current_task_id, TaskStates.PROCESSING, {
            reason: 'Goal input completed at provider boundary',
            historyMetadata: { paused: true, continuationKind: 'input' },
        });
        return { status: 'input_complete' };
    }

    await finalizeGoal(latest, result);
    if (result.success) {
        await stateManager.markTaskCompleted(goal.current_task_id, finalPr ? { prNumber: finalPr.number, prUrl: finalPr.url } : {});
        return { status: 'complete', goalId: goal.goal_id };
    }
    await stateManager.markTaskFailed(goal.current_task_id, new Error(result.error || 'Native goal execution failed'));
    return { status: 'failed', goalId: goal.goal_id };
}
