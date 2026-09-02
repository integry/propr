import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { GoalJobData } from '@propr/core';
import {
    db,
    executeDockerCommand,
    getIssueQueue,
    getStateManager,
    goalAttemptLabel,
    goalJobId,
    TaskStates,
    logger,
} from '@propr/core';

interface RecoverableGoal {
    goal_id: string;
    current_task_id: string;
    repository: string;
    worktree_path: string | null;
    session_id: string | null;
    started_at: string | null;
    desired_state: 'running' | 'paused' | 'cancelled';
    result_state: string | null;
    run_generation: number;
    run_claim: string | null;
    claimed_at: string | null;
    attempt_heartbeat_at: string | null;
    pause_confirmed_at: string | null;
    paused_at: string | null;
    resume_requested: boolean | number;
    final_pr_number?: number | null;
    final_pr_url?: string | null;
    failure_reason?: string | null;
    objective?: string;
    requested_model?: string;
    agent_alias?: string;
    task_reconciled_at?: string | null;
}

interface RecoveryJob { getState?(): Promise<string> }

export interface GoalRecoveryQueue {
    getJob(id: string): Promise<RecoveryJob | undefined | null>;
    add(name: string, data: GoalJobData, options: { jobId: string; attempts: number }): Promise<unknown>;
}

async function isRunningGoalContainer(taskId: string, attempt: string): Promise<boolean> {
    try {
        const result = await executeDockerCommand('docker', [
            'ps',
            '--filter', `label=propr.task.id=${taskId}`,
            '--filter', `label=propr.task.attempt-generation=${attempt}`,
            '--format', '{{.ID}}',
        ], { timeout: 10_000 });
        return result.exitCode !== 0 || result.stdout.trim().length > 0;
    } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Could not inspect exact goal attempt liveness');
        return true;
    }
}

async function stopRunningGoalContainer(taskId: string, attempt: string): Promise<boolean> {
    try {
        const listed = await executeDockerCommand('docker', [
            'ps', '--filter', `label=propr.task.id=${taskId}`,
            '--filter', `label=propr.task.attempt-generation=${attempt}`,
            '--format', '{{.ID}}',
        ], { timeout: 10_000 });
        if (listed.exitCode !== 0) return false;
        const ids = listed.stdout.split('\n').map(id => id.trim()).filter(Boolean);
        if (ids.length === 0) return true;
        const stopped = await executeDockerCommand('docker', ['rm', '-f', ...ids], { timeout: 30_000 });
        return stopped.exitCode === 0;
    } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Could not stop stale goal attempt at a safe boundary');
        return false;
    }
}

function stale(goal: RecoverableGoal, staleMs: number): boolean {
    if (!goal.claimed_at) return true;
    const heartbeat = goal.attempt_heartbeat_at || goal.claimed_at;
    return Date.now() - new Date(heartbeat).getTime() >= staleMs;
}

async function enqueue(options: {
    queue: GoalRecoveryQueue;
    goal: RecoverableGoal;
    generation: number;
    claimId: string;
    recovery: boolean;
}): Promise<void> {
    const { queue, goal, generation, claimId, recovery } = options;
    const [repoOwner, repoName] = goal.repository.split('/');
    await queue.add('processGoal', {
        goalId: goal.goal_id,
        taskId: goal.current_task_id,
        repoOwner,
        repoName,
        generation,
        claimId,
        recovery,
    }, { jobId: goalJobId(goal.goal_id, generation), attempts: 1 });
}

async function failIdentityLessAttempt(database: Knex, goal: RecoverableGoal): Promise<boolean> {
    const changed = await database('goals').where({
        goal_id: goal.goal_id,
        run_generation: goal.run_generation,
        run_claim: goal.run_claim,
        desired_state: 'running',
    }).whereNull('result_state').update({
        result_state: 'failed',
        failure_reason: 'Worker/container was lost before a resumable provider identity was persisted',
        completed_at: database.fn.now(),
        updated_at: database.fn.now(),
    });
    return changed === 1;
}

async function recoverClaimedAttempt(
    database: Knex,
    queue: GoalRecoveryQueue,
    goal: RecoverableGoal,
): Promise<boolean> {
    const generation = goal.run_generation + 1;
    const claimId = randomUUID();
    const completedPauseMs = goal.desired_state === 'paused' && goal.paused_at
        ? Math.max(0, Date.now() - new Date(goal.paused_at).getTime())
        : 0;
    const changed = await database('goals').where({
        goal_id: goal.goal_id,
        run_generation: goal.run_generation,
        run_claim: goal.run_claim,
        desired_state: goal.desired_state,
    }).whereNull('result_state').update({
        desired_state: 'running',
        run_generation: generation,
        run_claim: claimId,
        claimed_at: null,
        attempt_heartbeat_at: null,
        active_turn_id: null,
        pause_confirmed_at: null,
        paused_at: null,
        paused_ms: database.raw('paused_ms + ?', [completedPauseMs]),
        resume_requested: false,
        updated_at: database.fn.now(),
    });
    if (changed !== 1) return false;
    await enqueue({ queue, goal, generation, claimId, recovery: true });
    return true;
}

async function enqueueUnclaimedAttempt(
    database: Knex,
    queue: GoalRecoveryQueue,
    goal: RecoverableGoal,
): Promise<boolean> {
    const claimId = goal.run_claim || randomUUID();
    if (!goal.run_claim) {
        const changed = await database('goals').where({
            goal_id: goal.goal_id,
            run_generation: goal.run_generation,
        }).whereNull('result_state').whereNull('run_claim').update({ run_claim: claimId, updated_at: database.fn.now() });
        if (changed !== 1) return false;
    }
    const existing = await queue.getJob(goalJobId(goal.goal_id, goal.run_generation));
    const state = await existing?.getState?.();
    if (existing && state && !['completed', 'failed'].includes(state)) return false;
    if (existing && state && ['completed', 'failed'].includes(state)) {
        // BullMQ returns retained terminal jobs instead of enqueueing them again.
        // Rotate the fenced attempt so recovery always receives a fresh job ID.
        const generation = goal.run_generation + 1;
        const rotatedClaim = randomUUID();
        const changed = await database('goals').where({
            goal_id: goal.goal_id,
            run_generation: goal.run_generation,
            run_claim: claimId,
        }).whereNull('result_state').whereNull('claimed_at').update({
            run_generation: generation,
            run_claim: rotatedClaim,
            updated_at: database.fn.now(),
        });
        if (changed !== 1) return false;
        await enqueue({ queue, goal, generation, claimId: rotatedClaim, recovery: Boolean(goal.session_id) });
        return true;
    }
    await enqueue({
        queue,
        goal,
        generation: goal.run_generation,
        claimId,
        recovery: Boolean(goal.session_id),
    });
    return true;
}

type RecoveryOutcome = 'recovered' | 'failedClosed' | 'skippedLive' | 'unchanged';

async function reconcileGoalTask(goal: RecoverableGoal): Promise<void> {
    if (!goal.result_state) return;
    const stateManager = getStateManager();
    let task = await stateManager.getTaskState(goal.current_task_id);
    if (!task) {
        const [repoOwner, repoName] = goal.repository.split('/');
        task = await stateManager.createTaskState(goal.current_task_id, {
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
    const expected = goal.result_state === 'completed'
        ? TaskStates.COMPLETED
        : goal.result_state === 'cancelled' ? TaskStates.CANCELLED : TaskStates.FAILED;
    if (task.state === expected) return;
    const failure = goal.failure_reason || 'Native goal execution failed';
    const prResult = goal.final_pr_number && goal.final_pr_url
        ? { prNumber: goal.final_pr_number, prUrl: goal.final_pr_url }
        : undefined;
    const changed = await stateManager.updateTaskStateIfCurrentDetailed(goal.current_task_id, {
        state: task.state,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        correlationId: task.correlationId,
        version: task.version,
    }, expected, {
        reason: goal.result_state === 'completed'
            ? 'Goal/task terminal state reconciled as completed'
            : goal.result_state === 'cancelled'
                ? 'Goal/task terminal state reconciled as cancelled'
                : `Goal/task terminal state reconciled as failed: ${failure}`,
        ...(prResult ? {
            prResult,
            historyMetadata: { pr: { number: prResult.prNumber, url: prResult.prUrl } },
        } : {}),
        ...(goal.result_state === 'failed'
            ? { error: { message: failure, category: 'unknown' as const } }
            : {}),
    });
    if (!changed) throw new Error(`Task ${goal.current_task_id} changed during terminal reconciliation`);
}

async function recoverGoal(options: {
    database: Knex;
    queue: GoalRecoveryQueue;
    goal: RecoverableGoal;
    isTaskContainerLive: (taskId: string, attempt: string) => Promise<boolean>;
    staleMs: number;
    stopTaskContainer: (taskId: string, attempt: string) => Promise<boolean>;
    reconcileTask: (goal: RecoverableGoal) => Promise<void>;
}): Promise<RecoveryOutcome> {
    const { database, queue, goal, isTaskContainerLive, stopTaskContainer, reconcileTask, staleMs } = options;
    if (goal.result_state) {
        await reconcileTask(goal);
        await database('goals').where({ goal_id: goal.goal_id, result_state: goal.result_state })
            .whereNull('task_reconciled_at').update({ task_reconciled_at: database.fn.now(), updated_at: database.fn.now() });
        return 'unchanged';
    }
    if (goal.desired_state === 'cancelled') {
        if (goal.run_claim && !await stopTaskContainer(
            goal.current_task_id,
            goalAttemptLabel(goal.run_generation, goal.run_claim),
        )) return 'unchanged';
        const cancelled = await database('goals').where({
            goal_id: goal.goal_id,
            run_generation: goal.run_generation,
            run_claim: goal.run_claim,
            desired_state: 'cancelled',
        }).whereNull('result_state').update({
            result_state: 'cancelled',
            active_turn_id: null,
            completed_at: database.fn.now(),
            updated_at: database.fn.now(),
        });
        if (cancelled !== 1) return 'unchanged';
        await reconcileTask({ ...goal, result_state: 'cancelled' });
        await database('goals').where({ goal_id: goal.goal_id, result_state: 'cancelled' })
            .whereNull('task_reconciled_at').update({ task_reconciled_at: database.fn.now(), updated_at: database.fn.now() });
        return 'recovered';
    }
    const pausedContinuation = goal.desired_state === 'paused'
        && Boolean(goal.resume_requested) && Boolean(goal.pause_confirmed_at);
    if (pausedContinuation) {
        return await recoverClaimedAttempt(database, queue, goal) ? 'recovered' : 'unchanged';
    }
    if (goal.desired_state === 'paused') {
        if (goal.pause_confirmed_at) return 'unchanged';
        if (!stale(goal, staleMs)) return 'unchanged';
        if (goal.run_claim && goal.claimed_at) {
            const attempt = goalAttemptLabel(goal.run_generation, goal.run_claim);
            if (await isTaskContainerLive(goal.current_task_id, attempt)
                && !await stopTaskContainer(goal.current_task_id, attempt)) return 'unchanged';
        }
        const confirmed = await database('goals').where({
            goal_id: goal.goal_id,
            run_generation: goal.run_generation,
            run_claim: goal.run_claim,
            desired_state: 'paused',
        }).whereNull('result_state').update({
            pause_confirmed_at: database.fn.now(),
            active_turn_id: null,
            updated_at: database.fn.now(),
        });
        if (confirmed !== 1) return 'unchanged';
        return goal.resume_requested
            ? await recoverClaimedAttempt(database, queue, { ...goal, pause_confirmed_at: new Date().toISOString() }) ? 'recovered' : 'unchanged'
            : 'recovered';
    }
    if (goal.desired_state !== 'running' || !stale(goal, staleMs)) return 'unchanged';
    if (!goal.claimed_at) {
        return await enqueueUnclaimedAttempt(database, queue, goal) ? 'recovered' : 'unchanged';
    }
    const claim = goal.run_claim;
    if (!claim) return await failIdentityLessAttempt(database, goal) ? 'failedClosed' : 'unchanged';
    if (await isTaskContainerLive(goal.current_task_id, goalAttemptLabel(goal.run_generation, claim))) return 'skippedLive';
    if (!goal.session_id || !goal.worktree_path) {
        return await failIdentityLessAttempt(database, goal) ? 'failedClosed' : 'unchanged';
    }
    return await recoverClaimedAttempt(database, queue, goal) ? 'recovered' : 'unchanged';
}

export async function recoverNonterminalGoals(options: {
    database?: Knex;
    queue?: GoalRecoveryQueue;
    isTaskContainerLive?: (taskId: string, attempt: string) => Promise<boolean>;
    staleMs?: number;
    stopTaskContainer?: (taskId: string, attempt: string) => Promise<boolean>;
    reconcileTask?: (goal: RecoverableGoal) => Promise<void>;
} = {}): Promise<{ recovered: number; failedClosed: number; skippedLive: number }> {
    const database = options.database ?? db;
    const queue = options.queue ?? await getIssueQueue() as unknown as GoalRecoveryQueue;
    const isTaskContainerLive = options.isTaskContainerLive ?? isRunningGoalContainer;
    const staleMs = options.staleMs ?? 90_000;
    const goals = await database<RecoverableGoal>('goals')
        .where(builder => builder
            .where(subquery => subquery.whereNull('result_state').whereIn('desired_state', ['running', 'paused', 'cancelled']))
            .orWhere(subquery => subquery.whereIn('result_state', ['completed', 'failed', 'cancelled']).whereNull('task_reconciled_at')));
    const counts = { recovered: 0, failedClosed: 0, skippedLive: 0, unchanged: 0 };

    for (const goal of goals) {
        const outcome = await recoverGoal({
            database, queue, goal, isTaskContainerLive,
            stopTaskContainer: options.stopTaskContainer ?? stopRunningGoalContainer,
            reconcileTask: options.reconcileTask ?? reconcileGoalTask,
            staleMs,
        });
        counts[outcome] += 1;
    }
    return { recovered: counts.recovered, failedClosed: counts.failedClosed, skippedLive: counts.skippedLive };
}
