import { randomUUID } from 'node:crypto';
import { db, getIssueQueue, goalJobId, type GoalJobData } from '@propr/core';
import type { GoalRow } from './goalAttemptState.js';

/** Rotate the operational attempt while preserving the one provider session and worktree. */
export async function enqueueNextGoalAttempt(
    goal: GoalRow,
    current: GoalJobData,
    recovery = false,
): Promise<boolean> {
    const generation = current.generation + 1;
    const claimId = randomUUID();
    const completedPauseMs = goal.desired_state === 'paused' && goal.paused_at
        ? Math.max(0, Date.now() - new Date(goal.paused_at).getTime())
        : 0;
    const changed = await db('goals').where({
        goal_id: current.goalId,
        current_task_id: current.taskId,
        run_generation: current.generation,
        run_claim: current.claimId,
        desired_state: goal.desired_state,
    }).whereNull('result_state').update({
        desired_state: 'running',
        run_generation: generation,
        run_claim: claimId,
        claimed_at: null,
        attempt_heartbeat_at: null,
        active_turn_id: null,
        paused_at: null,
        pause_confirmed_at: null,
        resume_requested: false,
        paused_ms: db.raw('paused_ms + ?', [completedPauseMs]),
        updated_at: db.fn.now(),
    });
    if (changed !== 1) return false;
    const [repoOwner, repoName] = goal.repository.split('/');
    const queue = await getIssueQueue();
    await queue.add('processGoal', {
        goalId: goal.goal_id,
        taskId: goal.current_task_id,
        repoOwner,
        repoName,
        generation,
        claimId,
        recovery,
    }, { jobId: goalJobId(goal.goal_id, generation), attempts: 1 });
    return true;
}
