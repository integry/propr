import type { Knex } from 'knex';
import { DURABLE_GOAL_EVENT_SCHEMA_VERSION, type DurableGoalEventType } from '@propr/shared';
import type { GoalEventRecord } from './goalTypes.js';
import { nowIso } from './goalRepositorySupport.js';
import { canonicalizeRuntimeJson } from './strictCanonicalJson.js';

export interface GoalEventStateRecord {
  goal_id: string;
  high_watermark: number;
  min_retained_sequence: number;
  projection_sequence: number;
  checkpoint_sequence: number;
}

export interface ControlEventIdentity {
  sessionId: string;
  turnId: string;
  executionId: string;
  attemptId: string;
  providerSequence: number;
  chunkIndex?: number;
  leaseGeneration: number;
}

export async function ensureGoalEventState(
  trx: Knex.Transaction,
  goalId: string
): Promise<void> {
  const maximum = await trx('goal_events').where('goal_id', goalId)
    .max('sequence as value').first() as { value?: number };
  const highWatermark = Number(maximum?.value ?? 0);
  await trx('goal_event_state').insert({
    goal_id: goalId,
    high_watermark: highWatermark,
    min_retained_sequence: 1,
    projection_sequence: highWatermark,
    checkpoint_sequence: 0,
    updated_at: nowIso(),
  }).onConflict('goal_id').ignore();
}

export async function allocateGoalEventSequence(
  trx: Knex.Transaction,
  goalId: string
): Promise<number> {
  await ensureGoalEventState(trx, goalId);
  await trx('goal_event_state').where('goal_id', goalId)
    .increment('high_watermark', 1).update({ updated_at: nowIso() });
  const state = await trx<GoalEventStateRecord>('goal_event_state')
    .where('goal_id', goalId).first();
  if (!state) throw new Error(`Could not allocate goal event sequence for ${goalId}`);
  return state.high_watermark;
}

export async function appendControlEvent(
  trx: Knex.Transaction,
  goal: { goal_id: string; lease_epoch: number },
  input: {
    type: DurableGoalEventType;
    kind?: 'lifecycle' | 'domain';
    payload: Record<string, unknown>;
    idempotencyKey: string;
    identity: ControlEventIdentity;
    createdAt?: string;
  }
): Promise<number> {
  const existing = await trx<GoalEventRecord>('goal_events').where({
    goal_id: goal.goal_id,
    idempotency_key: input.idempotencyKey,
  }).first();
  const payloadJson = canonicalizeRuntimeJson(input.payload);
  if (existing) {
    if (existing.event_type !== input.type || existing.payload_json !== payloadJson
      || existing.source_session_id !== input.identity.sessionId
      || existing.source_turn_id !== input.identity.turnId
      || existing.source_execution_id !== input.identity.executionId
      || existing.source_attempt_id !== input.identity.attemptId
      || existing.source_provider_sequence !== input.identity.providerSequence
      || existing.source_chunk_index !== (input.identity.chunkIndex ?? 0)
      || existing.lease_generation !== input.identity.leaseGeneration) {
      throw new Error(`Conflicting internal goal event identity: ${input.idempotencyKey}`);
    }
    return existing.sequence;
  }
  const sequence = await allocateGoalEventSequence(trx, goal.goal_id);
  await trx('goal_events').insert({
    goal_id: goal.goal_id,
    sequence,
    kind: input.kind ?? (input.type === 'lifecycle.state_changed' ? 'lifecycle' : 'domain'),
    event_type: input.type,
    payload_json: payloadJson,
    idempotency_key: input.idempotencyKey,
    lease_epoch: goal.lease_epoch,
    schema_version: DURABLE_GOAL_EVENT_SCHEMA_VERSION,
    source_session_id: input.identity.sessionId,
    source_turn_id: input.identity.turnId,
    source_execution_id: input.identity.executionId,
    source_attempt_id: input.identity.attemptId,
    source_provider_sequence: input.identity.providerSequence,
    source_chunk_index: input.identity.chunkIndex ?? 0,
    lease_generation: input.identity.leaseGeneration,
    payload_bytes: Buffer.byteLength(payloadJson),
    created_at: input.createdAt ?? nowIso(),
  });
  return sequence;
}

export function lifecycleControlIdentity(
  goalId: string,
  version: number,
  leaseGeneration: number,
  actor: string
): ControlEventIdentity {
  const occurrence = `${goalId}:${version}`;
  return {
    sessionId: `control:${actor}`,
    turnId: occurrence,
    executionId: occurrence,
    attemptId: occurrence,
    providerSequence: version,
    leaseGeneration: Math.max(leaseGeneration, 1),
  };
}
