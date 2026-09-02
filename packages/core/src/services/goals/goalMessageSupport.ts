import type { Knex } from 'knex';
import {
  GOAL_CANNED_ACTIONS, GOAL_ERROR_CODES, GOAL_MESSAGE_BODY_MAX_LENGTH,
  type DurableGoalEventType, type GoalCannedAction,
} from '@propr/shared';
import type {
  ClaimMessageInput, EnqueueMessageInput, GoalLeaseFence, GoalMessage,
  GoalMessageRecord, GoalProviderSessionRecord, MessageDeliveryFence,
} from './goalTypes.js';
import {
  GoalError, boundedText, idempotencyKey, nowIso, requireGoalRecord, toMessage,
} from './goalRepositorySupport.js';
import { appendControlEvent } from './goalEventWriter.js';

export interface NormalizedMessage {
  messageId: string | null; body: string; cannedAction: GoalCannedAction | null;
  authorUserId: string; idempotencyKey: string;
}

export function normalizeMessage(input: EnqueueMessageInput, defaultAuthor: string): NormalizedMessage {
  const canned = input.cannedAction ?? input.predefinedKind ?? null;
  if (canned !== null && !GOAL_CANNED_ACTIONS.includes(canned as GoalCannedAction)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'cannedAction is not recognized', 400);
  }
  const cannedAction = canned as GoalCannedAction | null;
  const suppliedBody = typeof input.body === 'string' && input.body.trim() ? input.body : null;
  if (!suppliedBody && !cannedAction) throw new GoalError(GOAL_ERROR_CODES.validation, 'body or cannedAction is required', 400);
  if (suppliedBody && cannedAction) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'body and cannedAction are mutually exclusive', 400);
  }
  return {
    messageId: boundedText(input.messageId, 'messageId', undefined, true),
    body: cannedAction ? '' : boundedText(suppliedBody, 'body', GOAL_MESSAGE_BODY_MAX_LENGTH) as string,
    cannedAction, authorUserId: boundedText(input.authorUserId ?? defaultAuthor, 'authorUserId') as string,
    idempotencyKey: idempotencyKey(input.idempotencyKey),
  };
}

export type DeliveryIdentity = ReturnType<typeof normalizeDeliveryIdentity>;

export function normalizeDeliveryIdentity(input: ClaimMessageInput) {
  if (!Number.isSafeInteger(input.providerSequence) || input.providerSequence < 0
    || !Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Provider delivery ordering is invalid', 400);
  }
  const text = (value: unknown, field: string) => boundedText(value, field) as string;
  return {
    messageId: text(input.messageId, 'messageId'),
    sessionId: text(input.sessionId, 'sessionId'), turnId: text(input.turnId, 'turnId'),
    executionId: text(input.executionId, 'executionId'), attemptId: text(input.attemptId, 'attemptId'),
    controllerId: text(input.controllerId, 'controllerId'),
    deliveryKey: idempotencyKey(input.deliveryKey),
    providerIdempotencyKey: idempotencyKey(input.providerIdempotencyKey),
    providerSequence: input.providerSequence, chunkIndex: input.chunkIndex,
  };
}

export function messageConflict(message: string): GoalError {
  return new GoalError(GOAL_ERROR_CODES.messageOrderConflict, message, 409);
}

export function requireEnhanced(value: boolean): void {
  if (!value) throw new GoalError(GOAL_ERROR_CODES.validation, 'Durable goal message migration is not installed', 503);
}

export async function latestSequence(db: Knex, goalId: string): Promise<number> {
  if (await db.schema.hasTable('goal_event_state')) {
    const state = await db('goal_event_state').where('goal_id', goalId).first('high_watermark');
    return Number(state?.high_watermark ?? 0);
  }
  const row = await db('goal_events').where('goal_id', goalId)
    .max('sequence as value').first() as { value?: number };
  return Number(row?.value ?? 0);
}

export async function nextMessageOrdinal(trx: Knex.Transaction, goalId: string): Promise<number> {
  const row = await trx('goal_messages').where('goal_id', goalId)
    .max('sequence as value').first() as { value?: number };
  return Number(row?.value ?? 0) + 1;
}

export function compareMessage(row: GoalMessageRecord, input: NormalizedMessage): GoalMessage {
  if (row.message_id !== (input.messageId ?? row.message_id)
    || !input.cannedAction && row.body !== input.body
    || (row.canned_action ?? row.predefined_kind) !== input.cannedAction
    || (row.author_user_id ?? input.authorUserId) !== input.authorUserId) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Message idempotency key was reused with a different payload', 409);
  }
  return toMessage(row);
}

export async function buildAuthoritativeStatusBody(
  trx: Knex.Transaction, goalId: string, action: GoalCannedAction
): Promise<string> {
  const goal = await requireGoalRecord(trx, goalId);
  const rows = await trx('goal_nodes').where('goal_id', goalId)
    .groupBy('status').select('status').count({ count: '*' }) as Array<{ status: string; count: number | string }>;
  const counts = new Map(rows.map(row => [String(row.status), Number(row.count)]));
  const completed = counts.get('completed') ?? 0;
  const remaining = rows.reduce((total, row) => (
    row.status === 'completed' || row.status === 'cancelled' ? total : total + Number(row.count)
  ), 0);
  return action === 'whats_done'
    ? `Controller status ${goal.state}: ${completed} authoritative checklist item(s) completed.`
    : `Controller status ${goal.state}: ${remaining} authoritative checklist item(s) left; `
      + `${counts.get('in_progress') ?? 0} active, ${counts.get('blocked') ?? 0} blocked, `
      + `${counts.get('failed') ?? 0} failed.`;
}

export function sanitizeError(value: string): string {
  if (typeof value !== 'string') return 'Provider delivery failed';
  return value.replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:token|password|secret|key)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .trim().slice(0, 500) || 'Provider delivery failed';
}

export async function requireMessage(trx: Knex.Transaction, goalId: string, messageId: string) {
  const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, message_id: messageId }).first();
  if (!message) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal message not found', 404);
  return message;
}

export async function assertFifoHead(
  trx: Knex.Transaction, goalId: string, message: GoalMessageRecord
): Promise<void> {
  const earlier = await trx('goal_messages').where('goal_id', goalId)
    .whereNotIn('state', ['acknowledged', 'failed', 'cancelled'])
    .andWhere('sequence', '<', message.sequence).first('message_id');
  if (earlier) throw messageConflict('An earlier message must be acknowledged first');
}

export async function guardDeliveryAttempt(
  trx: Knex.Transaction, goalId: string, identity: DeliveryIdentity, leaseEpoch: number
): Promise<void> {
  const session = await trx<GoalProviderSessionRecord>('goal_provider_sessions').where({
    goal_id: goalId, session_id: identity.sessionId,
  }).first();
  if (!session || session.lease_generation !== leaseEpoch
    || session.current_turn_id !== identity.turnId
    || session.current_execution_id !== identity.executionId
    || session.current_attempt_id !== identity.attemptId) {
    throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Message provider attempt identity is stale', 409);
  }
}

function deliveryColumns(identity: DeliveryIdentity, leaseEpoch: number): Record<string, unknown> {
  return {
    claimed_by: identity.sessionId, claimed_controller_id: identity.controllerId,
    claimed_turn_id: identity.turnId, claimed_execution_id: identity.executionId,
    claimed_attempt_id: identity.attemptId, claimed_provider_sequence: identity.providerSequence,
    claimed_chunk_index: identity.chunkIndex, claimed_lease_generation: leaseEpoch,
    delivery_key: identity.deliveryKey, provider_idempotency_key: identity.providerIdempotencyKey,
  };
}

export function clearDeliveryColumns(): Record<string, null> {
  return {
    claimed_by: null, claimed_controller_id: null, claimed_turn_id: null,
    claimed_execution_id: null, claimed_attempt_id: null, claimed_provider_sequence: null,
    claimed_chunk_index: null, claimed_lease_generation: null, delivery_key: null,
    provider_idempotency_key: null, claimed_at: null,
  };
}

function evidence(message: GoalMessageRecord, identity: DeliveryIdentity, leaseEpoch: number) {
  return {
    messageId: identity.messageId, queueOrdinal: message.queue_ordinal ?? message.sequence,
    sessionId: identity.sessionId, turnId: identity.turnId, executionId: identity.executionId,
    attemptId: identity.attemptId, controllerId: identity.controllerId,
    leaseGeneration: leaseEpoch, deliveryKey: identity.deliveryKey,
    providerIdempotencyKey: identity.providerIdempotencyKey,
    providerSequence: identity.providerSequence, providerChunkIndex: identity.chunkIndex,
  };
}

export function storedEvidence(message: GoalMessageRecord) {
  const required = [
    message.claimed_by, message.claimed_controller_id, message.claimed_turn_id,
    message.claimed_execution_id, message.claimed_attempt_id, message.claimed_lease_generation,
    message.delivery_key, message.provider_idempotency_key, message.claimed_provider_sequence,
    message.claimed_chunk_index,
  ];
  if (required.some(value => value === null || value === undefined)) {
    throw messageConflict('Message has incomplete migrated delivery identity');
  }
  return {
    messageId: message.message_id, queueOrdinal: message.queue_ordinal ?? message.sequence,
    sessionId: message.claimed_by!, controllerId: message.claimed_controller_id!,
    turnId: message.claimed_turn_id!, executionId: message.claimed_execution_id!,
    attemptId: message.claimed_attempt_id!, leaseGeneration: message.claimed_lease_generation!,
    deliveryKey: message.delivery_key!, providerIdempotencyKey: message.provider_idempotency_key!,
    providerSequence: message.claimed_provider_sequence!, providerChunkIndex: message.claimed_chunk_index!,
  };
}

export function assertDeliveryIdentity(
  message: GoalMessageRecord, identity: DeliveryIdentity, leaseEpoch: number
): void {
  const expected = deliveryColumns(identity, leaseEpoch);
  if (message.message_id !== identity.messageId
    || Object.entries(expected).some(([column, value]) => message[column as keyof GoalMessageRecord] !== value)) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Delivery key was reused with a different attempt identity', 409);
  }
}

export function assertDeliveryFence(
  message: GoalMessageRecord, messageId: string, fence: MessageDeliveryFence | GoalLeaseFence
): void {
  if (!('deliveryKey' in fence) || fence.messageId !== messageId) {
    throw messageConflict('Exact message delivery identity is required');
  }
  const identity = normalizeDeliveryIdentity(fence);
  assertDeliveryIdentity(message, identity, fence.leaseEpoch);
  if (fence.controllerId !== fence.leaseOwner) {
    throw messageConflict('Controller identity must match the active lease owner');
  }
}

export async function claimMessage(
  trx: Knex.Transaction,
  goal: { goal_id: string; lease_epoch: number },
  message: GoalMessageRecord,
  claim: { identity: DeliveryIdentity; leaseEpoch: number }
): Promise<GoalMessage> {
  const { identity, leaseEpoch } = claim;
  const sequence = await appendAudit(trx, goal, {
    type: 'message.claimed', payload: evidence(message, identity, leaseEpoch),
    idempotencyKey: `message:${message.message_id}:claim:${identity.deliveryKey}`,
  });
  const claimedAt = nowIso();
  const columns = deliveryColumns(identity, leaseEpoch);
  const affected = await trx('goal_messages').where({ message_id: message.message_id, state: 'queued' }).update({
    state: 'delivering', ...columns, claimed_at: claimedAt,
    delivery_attempts: message.delivery_attempts + 1, state_event_sequence: sequence, last_error: null,
  });
  if (affected !== 1) throw messageConflict('Message claim changed concurrently');
  return toMessage({
    ...message, state: 'delivering', ...columns, claimed_at: claimedAt,
    delivery_attempts: message.delivery_attempts + 1, state_event_sequence: sequence,
  });
}

export async function takeoverMessage(
  trx: Knex.Transaction,
  goal: { goal_id: string; lease_epoch: number },
  message: GoalMessageRecord,
  takeover: { identity: DeliveryIdentity; leaseEpoch: number }
): Promise<GoalMessage> {
  const { identity, leaseEpoch } = takeover;
  const sequence = await appendAudit(trx, goal, {
    type: 'message.claimed', payload: evidence(message, identity, leaseEpoch),
    idempotencyKey: `message:${message.message_id}:takeover:${identity.deliveryKey}`,
  });
  const claimedAt = nowIso();
  const columns = deliveryColumns(identity, leaseEpoch);
  const affected = await trx('goal_messages').where({
    message_id: message.message_id, state: message.state,
    claimed_lease_generation: message.claimed_lease_generation,
  }).update({ ...columns, claimed_at: claimedAt, state_event_sequence: sequence });
  if (affected !== 1) throw messageConflict('Message takeover changed concurrently');
  return toMessage({ ...message, ...columns, claimed_at: claimedAt, state_event_sequence: sequence });
}

export async function appendAudit(
  trx: Knex.Transaction,
  goal: { goal_id: string; lease_epoch: number },
  input: {
    type: DurableGoalEventType; payload: Record<string, unknown>;
    idempotencyKey: string; createdAt?: string;
  }
): Promise<number> {
  const messageId = String(input.payload.messageId ?? 'control');
  const turnId = String(input.payload.turnId ?? input.payload.authorUserId ?? 'control');
  const stage = ({
    'message.enqueued': 10, 'message.claimed': 11, 'message.delivered': 12,
    'message.acknowledged': 13, 'message.failed': 14, 'message.cancelled': 15,
  } as Partial<Record<DurableGoalEventType, number>>)[input.type] ?? 0;
  return appendControlEvent(trx, goal, {
    ...input,
    identity: {
      sessionId: String(input.payload.sessionId ?? `control:${messageId}`), turnId,
      executionId: String(input.payload.executionId ?? turnId),
      attemptId: String(input.payload.attemptId ?? turnId),
      providerSequence: Number(input.payload.providerSequence ?? input.payload.queueOrdinal ?? 0),
      chunkIndex: stage,
      leaseGeneration: Math.max(Number(input.payload.leaseGeneration ?? goal.lease_epoch), 1),
    },
  });
}
