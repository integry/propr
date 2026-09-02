import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { GoalJobData } from '@propr/core';
import {
    db,
    executeDockerCommand,
    getIssueQueue,
    goalAttemptLabel,
    goalJobId,
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

async function recoverGoal(options: {
    database: Knex;
    queue: GoalRecoveryQueue;
    goal: RecoverableGoal;
    isTaskContainerLive: (taskId: string, attempt: string) => Promise<boolean>;
    staleMs: number;
}): Promise<RecoveryOutcome> {
    const { database, queue, goal, isTaskContainerLive, staleMs } = options;
    const pausedContinuation = goal.desired_state === 'paused'
        && Boolean(goal.resume_requested) && Boolean(goal.pause_confirmed_at);
    if (pausedContinuation) {
        return await recoverClaimedAttempt(database, queue, goal) ? 'recovered' : 'unchanged';
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
} = {}): Promise<{ recovered: number; failedClosed: number; skippedLive: number }> {
    const database = options.database ?? db;
    const queue = options.queue ?? await getIssueQueue() as unknown as GoalRecoveryQueue;
    const isTaskContainerLive = options.isTaskContainerLive ?? isRunningGoalContainer;
    const staleMs = options.staleMs ?? 90_000;
    const goals = await database<RecoverableGoal>('goals')
        .whereNull('result_state')
        .whereIn('desired_state', ['running', 'paused']);
    const counts = { recovered: 0, failedClosed: 0, skippedLive: 0, unchanged: 0 };

    for (const goal of goals) {
        const outcome = await recoverGoal({ database, queue, goal, isTaskContainerLive, staleMs });
        counts[outcome] += 1;
    }
    return { recovered: counts.recovered, failedClosed: counts.failedClosed, skippedLive: counts.skippedLive };
}
