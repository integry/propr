import type { Knex } from 'knex';
import { db, type GoalExecutionControl, type GoalJobData } from '@propr/core';
import type { GoalArtifact } from '@propr/core';

export interface GoalRow {
    goal_id: string;
    owner_id: string;
    repository: string;
    objective: string;
    initial_prompt: string;
    base_branch: string | null;
    branch_name: string | null;
    worktree_path: string | null;
    agent_id: string;
    agent_alias: string;
    agent_type: string;
    requested_model: string;
    desired_state: 'running' | 'paused' | 'cancelled';
    result_state: 'completed' | 'failed' | 'cancelled' | null;
    current_task_id: string;
    session_id: string | null;
    conversation_id: string | null;
    run_generation: number;
    run_claim: string | null;
    claimed_at: string | null;
    active_turn_id: string | null;
    pause_confirmed_at: string | null;
    resume_requested: boolean | number;
    artifact_refs?: string | GoalArtifact[] | null;
    started_at: string | null;
    paused_at: string | null;
}

function attemptWhere(query: Knex.QueryBuilder, job: GoalJobData): Knex.QueryBuilder {
    return query.where({
        goal_id: job.goalId,
        current_task_id: job.taskId,
        run_generation: job.generation,
        run_claim: job.claimId,
    }).whereNull('result_state');
}

export async function claimGoalAttempt(job: GoalJobData): Promise<GoalRow | null> {
    const claimed = await attemptWhere(db('goals'), job)
        .where({ desired_state: 'running' })
        .whereNull('claimed_at')
        .update({
            claimed_at: db.fn.now(),
            attempt_heartbeat_at: db.fn.now(),
            started_at: db.raw('COALESCE(started_at, CURRENT_TIMESTAMP)'),
            pause_confirmed_at: null,
            updated_at: db.fn.now(),
        });
    if (claimed !== 1) return null;
    return attemptWhere(db<GoalRow>('goals'), job).first() as Promise<GoalRow | null>;
}

export async function fencedGoal(job: GoalJobData): Promise<GoalRow | null> {
    return attemptWhere(db<GoalRow>('goals'), job).first() as Promise<GoalRow | null>;
}

export async function fencedGoalUpdate(job: GoalJobData, values: Record<string, unknown>): Promise<boolean> {
    return await attemptWhere(db('goals'), job).update({ ...values, updated_at: db.fn.now() }) === 1;
}

export async function saveFencedGoalSession(
    job: GoalJobData,
    sessionId: string,
    conversationId?: string,
): Promise<boolean> {
    return fencedGoalUpdate(job, {
        session_id: sessionId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        attempt_heartbeat_at: db.fn.now(),
    });
}

export function createGoalExecutionControl(job: GoalJobData): GoalExecutionControl {
    return {
        async load() {
            const goal = await fencedGoal(job);
            if (!goal) throw new Error('Goal attempt ownership was superseded');
            const inputs = await db('goal_inputs')
                .where({ goal_id: job.goalId, owner_id: goal.owner_id, state: 'pending' })
                .orderBy('sequence', 'asc') as Array<{ input_id: string; message: string }>;
            return {
                desiredState: goal.desired_state,
                requestedModel: goal.requested_model,
                pendingInputs: inputs.map(input => ({ id: input.input_id, message: input.message })),
            };
        },
        async heartbeat() {
            if (!await fencedGoalUpdate(job, { attempt_heartbeat_at: db.fn.now() })) {
                throw new Error('Goal attempt heartbeat was fenced');
            }
        },
        async setActiveTurn(turnId) {
            if (!await fencedGoalUpdate(job, { active_turn_id: turnId })) {
                throw new Error('Goal active turn write was fenced');
            }
        },
        async markInputDelivered(inputId, turnId) {
            await db.transaction(async trx => {
                const owned = await attemptWhere(trx('goals'), job).first('owner_id');
                if (!owned) throw new Error('Goal input acknowledgement was fenced');
                const changed = await trx('goal_inputs').where({
                    input_id: inputId,
                    goal_id: job.goalId,
                    owner_id: owned.owner_id,
                    state: 'pending',
                }).update({
                    state: 'delivered',
                    delivered_generation: job.generation,
                    delivered_claim: job.claimId,
                    delivered_turn_id: turnId,
                    delivered_at: trx.fn.now(),
                });
                if (changed !== 1) throw new Error('Goal input was already delivered or superseded');
            });
        },
    };
}

export async function firstPendingGoalInput(goal: GoalRow): Promise<{ input_id: string; message: string } | null> {
    return await db('goal_inputs')
        .where({ goal_id: goal.goal_id, owner_id: goal.owner_id, state: 'pending' })
        .orderBy('sequence', 'asc')
        .first('input_id', 'message') ?? null;
}
