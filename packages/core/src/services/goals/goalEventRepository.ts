import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_ERROR_CODES,
  GOAL_EVENT_DEFAULT_LIMIT,
  GOAL_EVENT_KINDS,
  GOAL_EVENT_MAX_LIMIT,
  GOAL_MESSAGE_BODY_MAX_LENGTH,
  isTerminalGoalState,
} from '@propr/shared';
import type {
  AppendEventInput,
  EnqueueMessageInput,
  GoalEvent,
  GoalEventRecord,
  GoalLeaseFence,
  GoalMessage,
  GoalMessageRecord,
} from './goalTypes.js';
import {
  GoalError,
  boundedText,
  guardLease,
  goalTransaction,
  idempotencyKey,
  nowIso,
  requireGoalRecord,
  runIdempotent,
  toEvent,
  toMessage,
} from './goalRepositorySupport.js';
import { canonicalizeRuntimeJson, canonicalizeStoredJson } from './strictCanonicalJson.js';

const MAX_EVENT_PAYLOAD_BYTES = 65_536;

export class GoalEventRepository {
  constructor(private readonly db: Knex) {}

  async appendEvent(goalId: string, input: AppendEventInput): Promise<GoalEvent> {
    const normalized = normalizeEvent(input);
    return goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, normalized);
      const existing = await trx<GoalEventRecord>('goal_events').where({
        goal_id: goalId,
        idempotency_key: normalized.idempotencyKey,
      }).first();
      if (existing) {
        if (existing.kind !== normalized.kind || existing.event_type !== normalized.eventType
          || canonicalizeStoredPayload(existing.payload_json) !== normalized.payloadJson) {
          throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Event idempotency key was reused with a different payload', 409);
        }
        return toEvent(existing);
      }
      const sequence = await nextSequence(trx, 'goal_events', goalId);
      const record = {
        goal_id: goalId, sequence, kind: normalized.kind,
        event_type: normalized.eventType, payload_json: normalized.payloadJson,
        idempotency_key: normalized.idempotencyKey,
        lease_epoch: goal.lease_epoch, created_at: nowIso(),
      };
      const [id] = await trx('goal_events').insert(record);
      return toEvent({ ...record, id: id as number } as GoalEventRecord);
    });
  }

  async readEvents(
    goalId: string,
    options: { afterSequence?: number; limit?: number; kind?: string } = {}
  ): Promise<{ events: GoalEvent[]; nextCursor: number | null }> {
    if (options.afterSequence !== undefined
      && (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)) {
      throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Event cursor must be a non-negative integer', 400);
    }
    if (options.kind !== undefined && !GOAL_EVENT_KINDS.includes(options.kind as typeof GOAL_EVENT_KINDS[number])) {
      throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Event kind is not recognized', 400);
    }
    const limit = options.limit ?? GOAL_EVENT_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GOAL_EVENT_MAX_LIMIT) {
      throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${GOAL_EVENT_MAX_LIMIT}`, 400);
    }
    let builder = this.db<GoalEventRecord>('goal_events').where('goal_id', goalId);
    if (options.afterSequence !== undefined) builder = builder.andWhere('sequence', '>', options.afterSequence);
    if (options.kind) builder = builder.andWhere('kind', options.kind);
    const rows = await builder.orderBy('sequence', 'asc').limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      events: page.map(toEvent),
      nextCursor: rows.length > limit && page.length > 0 ? page.at(-1)!.sequence : null,
    };
  }

  async getLatestSequence(goalId: string): Promise<number> {
    const row = await this.db('goal_events').where('goal_id', goalId)
      .max('sequence as maxSeq').first() as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? 0;
  }

  async enqueueMessage(goalId: string, input: EnqueueMessageInput): Promise<GoalMessage> {
    const normalized = normalizeMessage(input);
    const goal = await requireGoalRecord(this.db, goalId);
    const request = {
      messageId: normalized.messageId,
      body: normalized.body,
      predefinedKind: normalized.predefinedKind,
    };
    return runIdempotent({
      db: this.db,
      ownerUserId: goal.owner_user_id,
      operation: `message:${goalId}`,
      key: normalized.idempotencyKey,
      request,
      goalId,
      effect: async (trx) => {
        const currentGoal = await requireGoalRecord(trx, goalId);
        if (isTerminalGoalState(currentGoal.state)) {
          throw new GoalError(
            GOAL_ERROR_CODES.terminalState,
            'Terminal goals cannot accept new messages',
            409
          );
        }
        const existing = await trx<GoalMessageRecord>('goal_messages').where({
          goal_id: goalId,
          idempotency_key: normalized.idempotencyKey,
        }).first();
        if (existing) return compareMessage(existing, normalized);
        if (normalized.messageId) {
          const duplicate = await trx('goal_messages').where('message_id', normalized.messageId).first('message_id');
          if (duplicate) throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Requested message identifier already exists', 409);
        }
        const record: GoalMessageRecord = {
          message_id: normalized.messageId ?? crypto.randomUUID(),
          goal_id: goalId,
          sequence: await nextSequence(trx, 'goal_messages', goalId),
          body: normalized.body,
          predefined_kind: normalized.predefinedKind,
          state: 'queued', delivered_at: null, acknowledged_at: null,
          delivery_attempts: 0, last_error: null,
          idempotency_key: normalized.idempotencyKey, created_at: nowIso(),
        };
        await trx('goal_messages').insert(record);
        return toMessage(record);
      },
    });
  }

  async getMessages(goalId: string): Promise<GoalMessage[]> {
    const rows = await this.db<GoalMessageRecord>('goal_messages').where('goal_id', goalId).orderBy('sequence', 'asc');
    return rows.map(toMessage);
  }

  async markMessageDelivered(goalId: string, messageId: string, fence: GoalLeaseFence): Promise<void> {
    const id = boundedText(messageId, 'messageId') as string;
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, message_id: id }).first();
      if (!message) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal message not found', 404);
      if (message.state === 'delivered') return;
      if (message.state !== 'queued') {
        throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'Acknowledged messages cannot be redelivered', 409);
      }
      const earlierQueued = await trx('goal_messages').where({ goal_id: goalId, state: 'queued' })
        .andWhere('sequence', '<', message.sequence).first('message_id');
      if (earlierQueued) throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'An earlier message must be delivered first', 409);
      const affected = await trx('goal_messages').where({ goal_id: goalId, message_id: id, state: 'queued' })
        .update({ state: 'delivered', delivered_at: nowIso(), delivery_attempts: message.delivery_attempts + 1, last_error: null });
      if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'Message delivery state changed concurrently', 409);
    });
  }

  async markMessageAcknowledged(goalId: string, messageId: string, fence: GoalLeaseFence): Promise<void> {
    const id = boundedText(messageId, 'messageId') as string;
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, message_id: id }).first();
      if (!message) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal message not found', 404);
      if (message.state === 'acknowledged') return;
      if (message.state !== 'delivered') {
        throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'Only a delivered message can be acknowledged', 409);
      }
      const earlier = await trx('goal_messages').where('goal_id', goalId)
        .whereNot('state', 'acknowledged').andWhere('sequence', '<', message.sequence).first('message_id');
      if (earlier) throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'An earlier message must be acknowledged first', 409);
      const affected = await trx('goal_messages').where({ goal_id: goalId, message_id: id, state: 'delivered' })
        .update({ state: 'acknowledged', acknowledged_at: nowIso() });
      if (affected !== 1) throw new GoalError(GOAL_ERROR_CODES.messageOrderConflict, 'Message acknowledgement state changed concurrently', 409);
    });
  }
}

async function nextSequence(trx: Knex.Transaction, table: 'goal_events' | 'goal_messages', goalId: string): Promise<number> {
  const row = await trx(table).where('goal_id', goalId).max('sequence as maxSeq').first() as { maxSeq: number | null } | undefined;
  return (row?.maxSeq ?? 0) + 1;
}

type NormalizedEvent = AppendEventInput & { payloadJson: string | null };

function normalizeEvent(input: AppendEventInput): NormalizedEvent {
  if (!GOAL_EVENT_KINDS.includes(input.kind)) throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Event kind is not recognized', 400);
  let payloadJson: string | null = null;
  if (Object.hasOwn(input, 'payload')) {
    try {
      payloadJson = canonicalizeRuntimeJson(input.payload);
    } catch {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'Event payload must be lossless JSON', 400);
    }
  }
  if (payloadJson !== null && Buffer.byteLength(payloadJson, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Event payload exceeds 65536 bytes', 400);
  }
  return {
    ...input,
    payloadJson,
    eventType: boundedText(input.eventType, 'eventType') as string,
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    leaseOwner: boundedText(input.leaseOwner, 'leaseOwner') as string,
  };
}

function canonicalizeStoredPayload(payloadJson: string | null): string | null {
  if (payloadJson === null) return null;
  try {
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) throw new Error('oversized');
    return canonicalizeStoredJson(payloadJson);
  } catch {
    throw new GoalError(
      GOAL_ERROR_CODES.idempotencyConflict,
      'Stored event payload is malformed or cannot be compared without loss',
      409
    );
  }
}

interface NormalizedMessage {
  messageId: string | null;
  body: string;
  predefinedKind: string | null;
  idempotencyKey: string;
}

function normalizeMessage(input: EnqueueMessageInput): NormalizedMessage {
  return {
    messageId: boundedText(input.messageId, 'messageId', undefined, true),
    body: boundedText(input.body, 'body', GOAL_MESSAGE_BODY_MAX_LENGTH) as string,
    predefinedKind: boundedText(input.predefinedKind, 'predefinedKind', undefined, true),
    idempotencyKey: idempotencyKey(input.idempotencyKey),
  };
}

function compareMessage(row: GoalMessageRecord, input: NormalizedMessage): GoalMessage {
  if (row.message_id !== (input.messageId ?? row.message_id)
    || row.body !== input.body || row.predefined_kind !== input.predefinedKind) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Message idempotency key was reused with a different payload', 409);
  }
  return toMessage(row);
}
