import type { Knex } from 'knex';
import { GOAL_ERROR_CODES, isTerminalGoalState } from '@propr/shared';
import type { GoalLeaseFence, GoalRecord } from './goalTypes.js';
import type { GoalNativeProjection, GoalRuntimeEvent } from './goalRuntimeTypes.js';
import {
  GoalError,
  guardLease,
  goalTransaction,
  nowIso,
  requireGoalRecord,
} from './goalRepositorySupport.js';

interface CancellationIntentRecord {
  goal_id: string;
  reason: string | null;
  terminal_reason: 'user_cancelled';
  requested_at: string;
  acknowledged_at: string | null;
}

interface ProjectionRecord {
  goal_id: string;
  execution_id: string;
  plan_json: string | null;
  todos_json: string | null;
  status_json: string | null;
  native_sequence: number;
  updated_at: string;
}

export class GoalRuntimeControlRepository {
  constructor(private readonly db: Knex) {}

  async hasPendingCancellation(goalId: string): Promise<boolean> {
    const row = await this.db<CancellationIntentRecord>('goal_cancellation_intents')
      .where({ goal_id: goalId }).whereNull('acknowledged_at').first();
    return Boolean(row);
  }

  async finalizeCancellation(input: {
    goalId: string;
    executionId: string;
    fence: GoalLeaseFence;
  }): Promise<void> {
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, input.goalId, input.fence);
      const intent = await trx<CancellationIntentRecord>('goal_cancellation_intents')
        .where({ goal_id: input.goalId }).whereNull('acknowledged_at').first();
      if (!intent) return;
      const goal = await requireGoalRecord(trx, input.goalId);
      await trx('goal_runtime_executions').where({
        goal_id: input.goalId,
        execution_id: input.executionId,
      }).update({ state: 'cancelled', heartbeat_at: nowIso(), updated_at: nowIso() });
      await markGoalCancelled(trx, goal, input.fence, intent.reason);
      await trx('goal_cancellation_intents').where({ goal_id: input.goalId })
        .update({ acknowledged_at: nowIso() });
    });
  }

  /**
   * Atomically closes steering only when every committed message is settled.
   * Message creation rejects `completing`, so a successful transition is the
   * durable closing handshake: no message can land behind the final read.
   */
  async beginCompletion(input: {
    goalId: string;
    fence: GoalLeaseFence;
    reason: string;
  }): Promise<boolean> {
    return goalTransaction(this.db, async trx => {
      await guardLease(trx, input.goalId, input.fence);
      const pending = await trx('goal_messages').where({ goal_id: input.goalId })
        .whereNot({ state: 'acknowledged' }).first('message_id');
      if (pending) return false;
      const goal = await requireGoalRecord(trx, input.goalId);
      if (goal.state === 'completing') return true;
      if (goal.state !== 'planning' && goal.state !== 'running') {
        throw new GoalError(
          GOAL_ERROR_CODES.invalidTransition,
          `Cannot close steering from ${goal.state}`,
          409
        );
      }
      const now = nowIso();
      const affected = await trx('goals').where({
        goal_id: input.goalId,
        version: goal.version,
        lease_owner: input.fence.leaseOwner,
        lease_epoch: input.fence.leaseEpoch,
      }).whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now).update({
        state: 'completing', version: goal.version + 1, updated_at: now,
      });
      if (affected !== 1) {
        throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Controller lease is stale', 409);
      }
      await trx('goal_state_transitions').insert({
        goal_id: input.goalId, from_state: goal.state, to_state: 'completing',
        reason: input.reason, lease_epoch: input.fence.leaseEpoch, created_at: now,
      });
      return true;
    });
  }

  async projectEvent(input: {
    goalId: string;
    executionId: string;
    event: GoalRuntimeEvent;
    fence: GoalLeaseFence;
  }): Promise<void> {
    const field = projectionField(input.event.eventType);
    if (!field) return;
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, input.goalId, input.fence);
      const sequence = input.event.nativeSequence ?? 0;
      const existing = await trx<ProjectionRecord>('goal_native_projections')
        .where({ goal_id: input.goalId }).first();
      if (existing && sequence > 0 && sequence < existing.native_sequence) return;
      const value = JSON.stringify(input.event.payload ?? null);
      const row = {
        execution_id: input.executionId,
        [field]: value,
        native_sequence: Math.max(existing?.native_sequence ?? 0, sequence),
        updated_at: nowIso(),
      };
      if (existing) await trx('goal_native_projections').where({ goal_id: input.goalId }).update(row);
      else await trx('goal_native_projections').insert({
        goal_id: input.goalId, plan_json: null, todos_json: null, status_json: null, ...row,
      });
    });
  }

  async getProjection(goalId: string): Promise<GoalNativeProjection> {
    const row = await this.db<ProjectionRecord>('goal_native_projections')
      .where({ goal_id: goalId }).first();
    return {
      plan: parse(row?.plan_json), todos: parse(row?.todos_json), status: parse(row?.status_json),
      nativeSequence: row?.native_sequence ?? 0, updatedAt: row?.updated_at ?? null,
    };
  }
}

async function markGoalCancelled(
  trx: Knex.Transaction,
  goal: GoalRecord,
  fence: GoalLeaseFence,
  reason: string | null
): Promise<void> {
  if (isTerminalGoalState(goal.state)) return;
  const now = nowIso();
  const affected = await trx('goals').where({
    goal_id: goal.goal_id, version: goal.version,
    lease_owner: fence.leaseOwner, lease_epoch: fence.leaseEpoch,
  }).update({
    state: 'cancelled', terminal_reason: 'user_cancelled',
    version: goal.version + 1, updated_at: now,
  });
  if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Controller lease is stale', 409);
  await trx('goal_state_transitions').insert({
    goal_id: goal.goal_id, from_state: goal.state, to_state: 'cancelled',
    reason, lease_epoch: fence.leaseEpoch, created_at: now,
  });
  if (goal.state === 'paused') {
    await trx('goal_pause_intervals').where({ goal_id: goal.goal_id }).whereNull('resumed_at')
      .update({ resumed_at: now });
  }
}

function projectionField(eventType: string): 'plan_json' | 'todos_json' | 'status_json' | null {
  const normalized = eventType.toLowerCase();
  if (normalized.includes('plan')) return 'plan_json';
  if (normalized.includes('todo')) return 'todos_json';
  if (normalized.includes('status')) return 'status_json';
  return null;
}

function parse(value: string | null | undefined): unknown | null {
  return value == null ? null : JSON.parse(value);
}
