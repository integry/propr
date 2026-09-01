/* eslint-disable max-lines -- event persistence, replay, messaging, and projections share one transaction boundary */
import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_CANNED_ACTIONS, GOAL_CANNED_ACTION_TEXT, GOAL_ERROR_CODES,
  GOAL_EVENT_DEFAULT_LIMIT, GOAL_EVENT_DEFAULT_MAX_BYTES, GOAL_EVENT_KINDS,
  GOAL_EVENT_MAX_BYTES, GOAL_EVENT_MAX_LIMIT, GOAL_MESSAGE_BODY_MAX_LENGTH,
  GOAL_MESSAGE_DEFAULT_LIMIT, GOAL_MESSAGE_MAX_LIMIT, GOAL_OUTPUT_CHUNK_MAX_BYTES,
  isDurableGoalEventType, isTerminalGoalState, validateDurableGoalEvent,
  type DurableGoalEventInput, type DurableGoalEventPayloadMap,
  type DurableGoalEventType, type GoalCannedAction,
} from '@propr/shared';
import type {
  AppendEventInput, ClaimMessageInput, EnqueueMessageInput, GoalEvent,
  GoalEventPageResult, GoalEventRecord, GoalLeaseFence, GoalMessage,
  GoalMessagePageResult, GoalMessageRecord, GoalProviderSessionRecord,
} from './goalTypes.js';
import {
  GoalError, boundedText, guardLease, goalTransaction, idempotencyKey, nowIso,
  requireGoalRecord, runIdempotent, toEvent, toMessage,
} from './goalRepositorySupport.js';
import {
  CANONICAL_JSON_MAX_BYTES, canonicalizeRuntimeJson, canonicalizeStoredJson,
} from './strictCanonicalJson.js';
import { decodeGoalPageCursor, encodeGoalPageCursor } from './goalPageCursor.js';

interface EventStateRecord {
  goal_id: string;
  high_watermark: number;
  min_retained_sequence: number;
  projection_sequence: number;
  checkpoint_sequence: number;
}

export class GoalEventRepository {
  constructor(private readonly db: Knex) {}

  /** Foundation-compatible append surface. Normalized runtimes use appendTypedEvent. */
  async appendEvent(goalId: string, input: AppendEventInput): Promise<GoalEvent> {
    const normalized = normalizeLegacyEvent(input);
    const enhanced = await this.hasEnhancedSchema();
    return goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, normalized);
      const existing = await findIdempotentEvent(trx, goalId, normalized.idempotencyKey);
      if (existing) return compareEvent(existing, normalized.kind, normalized.eventType, normalized.payloadJson);
      const sequence = enhanced
        ? await allocateEventSequence(trx, goalId)
        : await nextLegacySequence(trx, 'goal_events', goalId);
      const createdAt = nowIso();
      const record = {
        goal_id: goalId, sequence, kind: normalized.kind,
        event_type: normalized.eventType, payload_json: normalized.payloadJson,
        idempotency_key: normalized.idempotencyKey,
        lease_epoch: goal.lease_epoch, created_at: createdAt,
        ...(enhanced ? {
          schema_version: 1, lease_generation: goal.lease_epoch,
          payload_bytes: normalized.payloadJson === null ? 0 : Buffer.byteLength(normalized.payloadJson),
        } : {}),
      };
      const [id] = await trx('goal_events').insert(record);
      return toEvent({ ...record, id: id as number } as GoalEventRecord);
    });
  }

  /** Strict normalized-runtime ingestion with deterministic malformed quarantine. */
  async appendTypedEvent(goalId: string, input: unknown): Promise<GoalEvent> {
    if (!await this.hasEnhancedSchema()) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'Durable goal event migration is not installed', 503);
    }
    const validation = validateDurableGoalEvent(input);
    if (!validation.ok) {
      const candidate = input as Partial<DurableGoalEventInput> | null;
      const fence = candidate && typeof candidate === 'object'
        ? { leaseOwner: candidate.leaseOwner, leaseEpoch: candidate.leaseEpoch }
        : null;
      if (fence && typeof fence.leaseOwner === 'string' && Number.isSafeInteger(fence.leaseEpoch)) {
        await goalTransaction(this.db, async trx => {
          await guardLease(trx, goalId, fence as GoalLeaseFence);
          await trx('goal_event_quarantine').insert({
            goal_id: goalId,
            idempotency_key: safeQuarantineKey(candidate?.idempotencyKey),
            event_type: typeof candidate?.type === 'string' ? candidate.type.slice(0, 255) : null,
            reason: (validation.error ?? 'invalid event').slice(0, 500),
            payload_digest: digestUnknown(input), created_at: nowIso(),
          }).onConflict(['goal_id', 'idempotency_key']).ignore();
        });
      }
      throw new GoalError(
        typeof candidate?.type === 'string' && !isDurableGoalEventType(candidate.type)
          ? GOAL_ERROR_CODES.invalidEventKind : GOAL_ERROR_CODES.validation,
        validation.error ?? 'Durable event is invalid', 400
      );
    }
    const typed = input as DurableGoalEventInput;
    validateSource(typed);
    const payloadJson = canonicalizePayload(typed.payload);
    if (typed.type === 'provider.output') validateOutputChunk(typed.payload, payloadJson);

    return goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, typed);
      await guardSourceIdentity(trx, goalId, typed);
      const byKey = await findIdempotentEvent(trx, goalId, typed.idempotencyKey);
      if (byKey) return compareTypedEvent(byKey, typed, payloadJson);
      const bySource = await findSourceEvent(trx, goalId, typed);
      if (bySource) return compareTypedEvent(bySource, typed, payloadJson);

      const sequence = await allocateEventSequence(trx, goalId);
      const createdAt = nowIso();
      const record: Omit<GoalEventRecord, 'id'> = {
        goal_id: goalId, sequence, kind: eventKind(typed.type), event_type: typed.type,
        payload_json: payloadJson, idempotency_key: idempotencyKey(typed.idempotencyKey),
        lease_epoch: goal.lease_epoch, created_at: createdAt,
        schema_version: typed.schemaVersion, source_session_id: typed.source.sessionId,
        source_turn_id: typed.source.turnId, source_execution_id: typed.source.executionId,
        source_attempt_id: typed.source.attemptId,
        source_provider_sequence: typed.source.providerSequence,
        source_chunk_index: typed.source.chunkIndex,
        lease_generation: typed.source.leaseGeneration,
        payload_bytes: Buffer.byteLength(payloadJson),
      };
      const [id] = await trx('goal_events').insert(record);
      await projectTypedEvent(trx, goalId, sequence, createdAt, typed);
      await trx('goal_event_state').where('goal_id', goalId).update({
        projection_sequence: sequence, updated_at: createdAt,
      });
      return toEvent({ ...record, id: id as number });
    });
  }

  /** Legacy numeric replay retained for controller callers. */
  async readEvents(
    goalId: string,
    options: { afterSequence?: number; limit?: number; kind?: string } = {}
  ): Promise<{ events: GoalEvent[]; nextCursor: number | null }> {
    validateAfterSequence(options.afterSequence);
    validateKind(options.kind);
    const limit = validateLimit(options.limit, GOAL_EVENT_DEFAULT_LIMIT, GOAL_EVENT_MAX_LIMIT);
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

  /** Opaque, filter-bound, count- and byte-bounded historical replay. */
  // eslint-disable-next-line complexity -- replay validates cursor, retention, filtering, and byte bounds together
  async readEventPage(
    goalId: string,
    options: {
      cursor?: string | null; afterSequence?: number; limit?: number;
      maxBytes?: number; kind?: string;
    } = {}
  ): Promise<GoalEventPageResult> {
    validateAfterSequence(options.afterSequence);
    validateKind(options.kind);
    if (options.cursor && options.afterSequence !== undefined) {
      throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'cursor and afterSequence cannot be combined', 400);
    }
    const limit = validateLimit(options.limit, GOAL_EVENT_DEFAULT_LIMIT, GOAL_EVENT_MAX_LIMIT);
    const maxBytes = validateLimit(options.maxBytes, GOAL_EVENT_DEFAULT_MAX_BYTES, GOAL_EVENT_MAX_BYTES);
    const goal = await requireGoalRecord(this.db, goalId);
    const binding = {
      type: 'goal-events' as const, goalId, ownerUserId: goal.owner_user_id,
      repository: goal.repository, filter: options.kind ?? null,
    };
    const cursor = decodeGoalPageCursor(options.cursor, binding);
    const state = await this.eventState(goalId);
    const after = cursor?.sequence ?? options.afterSequence ?? state.min_retained_sequence - 1;
    if ((cursor || options.afterSequence !== undefined) && after < state.min_retained_sequence - 1) {
      throw new GoalError(GOAL_ERROR_CODES.cursorExpired, 'Goal event cursor expired after compaction', 410);
    }
    let query = this.db<GoalEventRecord>('goal_events').where('goal_id', goalId)
      .andWhere('sequence', '>', after).andWhere('sequence', '<=', state.high_watermark);
    if (options.kind) query = query.andWhere('kind', options.kind);
    const rows = await query.orderBy('sequence', 'asc').limit(limit + 1);
    const page: GoalEventRecord[] = [];
    let bytes = 2;
    for (const row of rows.slice(0, limit)) {
      const rowBytes = (row.payload_bytes ?? Buffer.byteLength(row.payload_json ?? '')) + 512;
      if (page.length > 0 && bytes + rowBytes > maxBytes) break;
      if (rowBytes > GOAL_EVENT_MAX_BYTES) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'Persisted event exceeds the replay memory bound', 500);
      }
      page.push(row);
      bytes += rowBytes;
    }
    const last = page.at(-1);
    const hasMore = Boolean(last) && (page.length < rows.length
      || rows.length > limit
      || last!.sequence < state.high_watermark && await this.hasEventAfter(
        goalId, last!.sequence, state.high_watermark, options.kind
      ));
    return {
      events: page.map(toEvent),
      nextCursor: hasMore && last ? encodeGoalPageCursor(binding, {
        sequence: last.sequence, createdAt: last.created_at,
      }) : null,
      lastCursor: last ? encodeGoalPageCursor(binding, {
        sequence: last.sequence, createdAt: last.created_at,
      }) : options.cursor ?? null,
      asOfSequence: state.high_watermark,
    };
  }

  async getLatestSequence(goalId: string): Promise<number> {
    if (await this.hasEnhancedSchema()) return (await this.eventState(goalId)).high_watermark;
    const row = await this.db('goal_events').where('goal_id', goalId)
      .max('sequence as maxSeq').first() as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? 0;
  }

  async enqueueMessage(goalId: string, input: EnqueueMessageInput): Promise<GoalMessage> {
    const enhanced = await this.hasEnhancedSchema();
    const goal = await requireGoalRecord(this.db, goalId);
    const normalized = normalizeMessage(input, goal.owner_user_id);
    const request = {
      messageId: normalized.messageId, body: normalized.body,
      cannedAction: normalized.cannedAction, authorUserId: normalized.authorUserId,
    };
    return runIdempotent({
      db: this.db, ownerUserId: goal.owner_user_id, operation: `message:${goalId}`,
      key: normalized.idempotencyKey, request, goalId,
      effect: async trx => {
        const currentGoal = await requireGoalRecord(trx, goalId);
        if (isTerminalGoalState(currentGoal.state)) {
          throw new GoalError(GOAL_ERROR_CODES.terminalState, 'Terminal goals cannot accept new messages', 409);
        }
        const existing = await trx<GoalMessageRecord>('goal_messages').where({
          goal_id: goalId, idempotency_key: normalized.idempotencyKey,
        }).first();
        if (existing) return compareMessage(existing, normalized);
        if (normalized.messageId) {
          const duplicate = await trx('goal_messages').where('message_id', normalized.messageId).first('message_id');
          if (duplicate) throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Requested message identifier already exists', 409);
        }
        const messageId = normalized.messageId ?? crypto.randomUUID();
        const queueOrdinal = await nextLegacySequence(trx, 'goal_messages', goalId);
        const createdAt = nowIso();
        const enqueueSequence = enhanced ? await appendInternalAudit(trx, currentGoal, {
          type: 'message.enqueued',
          payload: { messageId, queueOrdinal, authorUserId: normalized.authorUserId },
          idempotencyKey: `message:${messageId}:enqueued`, createdAt,
        }) : null;
        const record: GoalMessageRecord = {
          message_id: messageId, goal_id: goalId, sequence: queueOrdinal,
          body: normalized.body, predefined_kind: normalized.cannedAction,
          state: 'queued', delivered_at: null, acknowledged_at: null,
          delivery_attempts: 0, last_error: null,
          idempotency_key: normalized.idempotencyKey, created_at: createdAt,
          ...(enhanced ? {
            queue_ordinal: queueOrdinal, canned_action: normalized.cannedAction,
            author_user_id: normalized.authorUserId, claimed_by: null,
            claimed_turn_id: null, claimed_lease_generation: null, delivery_key: null,
            cancelled_at: null, failed_at: null, retry_count: 0,
            enqueue_event_sequence: enqueueSequence, state_event_sequence: enqueueSequence,
          } : {}),
        };
        await trx('goal_messages').insert(record);
        return toMessage(record);
      },
    });
  }

  /** Compatibility helper; API detail never calls this unbounded method. */
  async getMessages(goalId: string): Promise<GoalMessage[]> {
    const rows = await this.db<GoalMessageRecord>('goal_messages').where('goal_id', goalId)
      .orderBy('sequence', 'asc');
    return rows.map(toMessage);
  }

  async readMessagePage(
    goalId: string,
    options: { cursor?: string | null; limit?: number; state?: string } = {}
  ): Promise<GoalMessagePageResult> {
    const limit = validateLimit(options.limit, GOAL_MESSAGE_DEFAULT_LIMIT, GOAL_MESSAGE_MAX_LIMIT);
    const goal = await requireGoalRecord(this.db, goalId);
    const binding = {
      type: 'goal-messages' as const, goalId, ownerUserId: goal.owner_user_id,
      repository: goal.repository, filter: options.state ?? null,
    };
    const cursor = decodeGoalPageCursor(options.cursor, binding);
    let query = this.db<GoalMessageRecord>('goal_messages').where('goal_id', goalId)
      .andWhere('sequence', '>', cursor?.sequence ?? 0);
    if (options.state) query = query.andWhere('state', options.state);
    const rows = await query.orderBy('sequence', 'asc').limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      messages: page.map(toMessage),
      nextCursor: rows.length > limit && last ? encodeGoalPageCursor(binding, {
        sequence: last.sequence, createdAt: last.created_at,
      }) : null,
      asOfSequence: await this.getLatestSequence(goalId),
    };
  }

  async claimNextMessage(goalId: string, input: ClaimMessageInput): Promise<GoalMessage | null> {
    requireEnhanced(await this.hasEnhancedSchema());
    const sessionId = boundedText(input.sessionId, 'sessionId') as string;
    const turnId = boundedText(input.turnId, 'turnId') as string;
    const deliveryKey = idempotencyKey(input.deliveryKey);
    return goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, input);
      const accepted = await trx<GoalMessageRecord>('goal_messages').where({
        goal_id: goalId, delivery_key: deliveryKey,
      }).first();
      if (accepted) return toMessage(accepted);
      const blocking = await trx<GoalMessageRecord>('goal_messages').where('goal_id', goalId)
        .whereIn('state', ['delivering', 'delivered']).orderBy('queue_ordinal', 'asc').first();
      if (blocking) return null;
      const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, state: 'queued' })
        .orderBy('queue_ordinal', 'asc').first();
      if (!message) return null;
      const sequence = await appendInternalAudit(trx, goal, {
        type: 'message.claimed',
        payload: { messageId: message.message_id, queueOrdinal: message.queue_ordinal ?? message.sequence, turnId },
        idempotencyKey: `message:${message.message_id}:claim:${deliveryKey}`,
      });
      const affected = await trx('goal_messages').where({ message_id: message.message_id, state: 'queued' }).update({
        state: 'delivering', claimed_by: sessionId, claimed_turn_id: turnId,
        claimed_lease_generation: input.leaseEpoch, delivery_key: deliveryKey,
        delivery_attempts: message.delivery_attempts + 1,
        state_event_sequence: sequence, last_error: null,
      });
      if (affected !== 1) throw messageConflict('Message claim changed concurrently');
      return toMessage({
        ...message, state: 'delivering', claimed_by: sessionId, claimed_turn_id: turnId,
        claimed_lease_generation: input.leaseEpoch, delivery_key: deliveryKey,
        delivery_attempts: message.delivery_attempts + 1, state_event_sequence: sequence,
      });
    });
  }

  async markMessageDelivered(goalId: string, messageId: string, fence: GoalLeaseFence): Promise<void> {
    const id = boundedText(messageId, 'messageId') as string;
    const enhanced = await this.hasEnhancedSchema();
    await goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, fence);
      const message = await requireMessage(trx, goalId, id);
      if (message.state === 'delivered') return;
      const expected = enhanced ? 'delivering' : 'queued';
      if (message.state !== expected) throw messageConflict(`Only a ${expected} message can be delivered`);
      if (!enhanced) {
        const earlierQueued = await trx('goal_messages').where({ goal_id: goalId, state: 'queued' })
          .andWhere('sequence', '<', message.sequence).first('message_id');
        if (earlierQueued) throw messageConflict('An earlier message must be delivered first');
      }
      const deliveredAt = nowIso();
      const stateSequence = enhanced ? await appendInternalAudit(trx, goal, {
        type: 'message.delivered',
        payload: { messageId: id, queueOrdinal: message.queue_ordinal ?? message.sequence, turnId: message.claimed_turn_id ?? 'legacy-turn' },
        idempotencyKey: `message:${id}:delivered`, createdAt: deliveredAt,
      }) : null;
      const update: Record<string, unknown> = {
        state: 'delivered', delivered_at: deliveredAt,
        delivery_attempts: enhanced ? message.delivery_attempts : message.delivery_attempts + 1,
        last_error: null,
      };
      if (enhanced) update.state_event_sequence = stateSequence;
      const affected = await trx('goal_messages').where({ goal_id: goalId, message_id: id, state: expected }).update(update);
      if (affected !== 1) throw messageConflict('Message delivery state changed concurrently');
    });
  }

  async markMessageAcknowledged(goalId: string, messageId: string, fence: GoalLeaseFence): Promise<void> {
    const id = boundedText(messageId, 'messageId') as string;
    const enhanced = await this.hasEnhancedSchema();
    await goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, fence);
      const message = await requireMessage(trx, goalId, id);
      if (message.state === 'acknowledged') return;
      if (message.state !== 'delivered') throw messageConflict('Only a delivered message can be acknowledged');
      const earlier = await trx('goal_messages').where('goal_id', goalId)
        .whereNotIn('state', enhanced ? ['acknowledged', 'failed', 'cancelled'] : ['acknowledged'])
        .andWhere('sequence', '<', message.sequence).first('message_id');
      if (earlier) throw messageConflict('An earlier message must be acknowledged first');
      const acknowledgedAt = nowIso();
      const stateSequence = enhanced ? await appendInternalAudit(trx, goal, {
        type: 'message.acknowledged',
        payload: { messageId: id, queueOrdinal: message.queue_ordinal ?? message.sequence, turnId: message.claimed_turn_id ?? 'legacy-turn' },
        idempotencyKey: `message:${id}:acknowledged`, createdAt: acknowledgedAt,
      }) : null;
      const update: Record<string, unknown> = { state: 'acknowledged', acknowledged_at: acknowledgedAt };
      if (enhanced) update.state_event_sequence = stateSequence;
      const affected = await trx('goal_messages').where({ goal_id: goalId, message_id: id, state: 'delivered' }).update(update);
      if (affected !== 1) throw messageConflict('Message acknowledgement changed concurrently');
    });
  }

  // eslint-disable-next-line max-params -- public message transition keeps the lease fence and failure fields explicit
  async failMessage(goalId: string, messageId: string, fence: GoalLeaseFence, error: string, retryable = false): Promise<void> {
    requireEnhanced(await this.hasEnhancedSchema());
    const id = boundedText(messageId, 'messageId') as string;
    const sanitized = sanitizeError(error);
    await goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, fence);
      const message = await requireMessage(trx, goalId, id);
      if (message.state === 'failed') return;
      if (message.state !== 'delivering') throw messageConflict('Only a delivering message can fail');
      const failedAt = nowIso();
      const sequence = await appendInternalAudit(trx, goal, {
        type: 'message.failed',
        payload: { messageId: id, queueOrdinal: message.queue_ordinal ?? message.sequence, retryable, error: sanitized },
        idempotencyKey: `message:${id}:failed:${message.delivery_attempts}`, createdAt: failedAt,
      });
      await trx('goal_messages').where({ message_id: id, state: 'delivering' }).update({
        state: retryable ? 'queued' : 'failed', failed_at: failedAt,
        retry_count: (message.retry_count ?? 0) + 1, last_error: sanitized,
        claimed_by: null, claimed_turn_id: null, claimed_lease_generation: null,
        delivery_key: retryable ? null : message.delivery_key, state_event_sequence: sequence,
      });
    });
  }

  async cancelMessage(goalId: string, messageId: string, authorUserId: string): Promise<GoalMessage> {
    requireEnhanced(await this.hasEnhancedSchema());
    const id = boundedText(messageId, 'messageId') as string;
    const author = boundedText(authorUserId, 'authorUserId') as string;
    return goalTransaction(this.db, async trx => {
      const goal = await requireGoalRecord(trx, goalId);
      const message = await requireMessage(trx, goalId, id);
      if (message.state === 'cancelled') return toMessage(message);
      if (message.state !== 'queued') throw messageConflict('Only a queued message can be cancelled safely');
      const cancelledAt = nowIso();
      const sequence = await appendInternalAudit(trx, goal, {
        type: 'message.cancelled',
        payload: { messageId: id, queueOrdinal: message.queue_ordinal ?? message.sequence, authorUserId: author },
        idempotencyKey: `message:${id}:cancelled`, createdAt: cancelledAt,
      });
      const affected = await trx('goal_messages').where({ message_id: id, state: 'queued' }).update({
        state: 'cancelled', cancelled_at: cancelledAt, state_event_sequence: sequence,
      });
      if (affected !== 1) throw messageConflict('Message cancellation changed concurrently');
      return toMessage({ ...message, state: 'cancelled', cancelled_at: cancelledAt, state_event_sequence: sequence });
    });
  }

  async compactOutput(goalId: string, throughSequence: number, fence: GoalLeaseFence): Promise<void> {
    requireEnhanced(await this.hasEnhancedSchema());
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'throughSequence must be a positive integer', 400);
    }
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, goalId, fence);
      const state = await trx<EventStateRecord>('goal_event_state').where('goal_id', goalId).first();
      if (!state || throughSequence > state.high_watermark) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'Compaction boundary exceeds the event watermark', 400);
      }
      const rows = await trx<GoalEventRecord>('goal_events').where('goal_id', goalId)
        .andWhere('sequence', '<=', throughSequence).andWhere('event_type', 'provider.output')
        .orderBy('sequence', 'asc');
      const digest = crypto.createHash('sha256');
      let bytes = 0;
      for (const row of rows) {
        digest.update(`${row.sequence}:${row.payload_json ?? ''}\n`);
        bytes += row.payload_bytes ?? Buffer.byteLength(row.payload_json ?? '');
      }
      await trx('goal_compaction_checkpoints').insert({
        goal_id: goalId, through_sequence: throughSequence,
        content_digest: digest.digest('hex'), removed_event_count: rows.length,
        removed_payload_bytes: bytes, created_at: nowIso(),
      }).onConflict(['goal_id', 'through_sequence']).ignore();
      await trx('goal_events').where('goal_id', goalId).andWhere('sequence', '<=', throughSequence)
        .andWhere('event_type', 'provider.output').delete();
      await trx('goal_event_state').where('goal_id', goalId).update({
        min_retained_sequence: throughSequence + 1, checkpoint_sequence: throughSequence,
        updated_at: nowIso(),
      });
    });
  }

  private async hasEnhancedSchema(): Promise<boolean> {
    return this.db.schema.hasTable('goal_event_state');
  }

  private async eventState(goalId: string): Promise<EventStateRecord> {
    if (!await this.hasEnhancedSchema()) {
      const high = await this.db('goal_events').where('goal_id', goalId).max('sequence as high').first() as { high?: number };
      return { goal_id: goalId, high_watermark: Number(high?.high ?? 0), min_retained_sequence: 1, projection_sequence: 0, checkpoint_sequence: 0 };
    }
    let state = await this.db<EventStateRecord>('goal_event_state').where('goal_id', goalId).first();
    if (!state) {
      await goalTransaction(this.db, trx => ensureEventState(trx, goalId));
      state = await this.db<EventStateRecord>('goal_event_state').where('goal_id', goalId).first();
    }
    if (!state) throw new Error(`Missing event state for goal ${goalId}`);
    return state;
  }

  private async hasEventAfter(goalId: string, after: number, high: number, kind?: string): Promise<boolean> {
    let query = this.db('goal_events').where('goal_id', goalId)
      .andWhere('sequence', '>', after).andWhere('sequence', '<=', high);
    if (kind) query = query.andWhere('kind', kind);
    return Boolean(await query.first('sequence'));
  }
}

async function ensureEventState(trx: Knex.Transaction, goalId: string): Promise<void> {
  const max = await trx('goal_events').where('goal_id', goalId).max('sequence as value').first() as { value?: number };
  const high = Number(max?.value ?? 0);
  await trx('goal_event_state').insert({
    goal_id: goalId, high_watermark: high, min_retained_sequence: 1,
    projection_sequence: high, checkpoint_sequence: 0, updated_at: nowIso(),
  }).onConflict('goal_id').ignore();
}

async function allocateEventSequence(trx: Knex.Transaction, goalId: string): Promise<number> {
  await ensureEventState(trx, goalId);
  await trx('goal_event_state').where('goal_id', goalId).increment('high_watermark', 1).update({ updated_at: nowIso() });
  const row = await trx<EventStateRecord>('goal_event_state').where('goal_id', goalId).first();
  if (!row) throw new Error(`Could not allocate goal event sequence for ${goalId}`);
  return row.high_watermark;
}

async function appendInternalAudit(
  trx: Knex.Transaction,
  goal: { goal_id: string; lease_epoch: number },
  input: { type: DurableGoalEventType; payload: Record<string, unknown>; idempotencyKey: string; createdAt?: string }
): Promise<number> {
  const existing = await findIdempotentEvent(trx, goal.goal_id, input.idempotencyKey);
  if (existing) return existing.sequence;
  const payloadJson = canonicalizePayload(input.payload);
  const sequence = await allocateEventSequence(trx, goal.goal_id);
  await trx('goal_events').insert({
    goal_id: goal.goal_id, sequence, kind: 'domain', event_type: input.type,
    payload_json: payloadJson, idempotency_key: input.idempotencyKey,
    lease_epoch: goal.lease_epoch, lease_generation: goal.lease_epoch,
    schema_version: 1, payload_bytes: Buffer.byteLength(payloadJson),
    created_at: input.createdAt ?? nowIso(),
  });
  return sequence;
}

async function guardSourceIdentity(trx: Knex.Transaction, goalId: string, input: DurableGoalEventInput): Promise<void> {
  const session = await trx<GoalProviderSessionRecord>('goal_provider_sessions').where({
    goal_id: goalId, session_id: input.source.sessionId,
  }).first();
  if (!session || session.lease_generation !== input.source.leaseGeneration
    || input.source.leaseGeneration !== input.leaseEpoch
    || session.current_turn_id && session.current_turn_id !== input.source.turnId
    || session.current_execution_id && session.current_execution_id !== input.source.executionId
    || session.current_attempt_id && session.current_attempt_id !== input.source.attemptId) {
    throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Provider source identity is stale', 409);
  }
}

// eslint-disable-next-line max-params -- projection receives the transaction and immutable event coordinates explicitly
async function projectTypedEvent(
  trx: Knex.Transaction, goalId: string, sequence: number, createdAt: string,
  event: DurableGoalEventInput
): Promise<void> {
  if (event.type === 'usage.reported') {
    await projectUsage(trx, goalId, sequence, event);
  } else if (event.type === 'provider.todo') {
    await trx('goal_provider_todos').where({ goal_id: goalId, session_id: event.source.sessionId }).delete();
    for (const item of event.payload.items) {
      await trx('goal_provider_todos').insert({
        goal_id: goalId, session_id: event.source.sessionId, todo_id: item.id,
        body: item.text, status: item.status, event_sequence: sequence,
      });
    }
  } else {
    const external = externalProjection(event);
    if (external) {
      await trx('goal_external_projections').insert({
        goal_id: goalId, entity_type: external.type, entity_number: external.number,
        status: external.status, event_sequence: sequence, updated_at: createdAt,
      }).onConflict(['goal_id', 'entity_type', 'entity_number']).merge({
        status: external.status, event_sequence: sequence, updated_at: createdAt,
      });
    }
  }
}

async function projectUsage(
  trx: Knex.Transaction, goalId: string, sequence: number,
  event: Extract<DurableGoalEventInput, { type: 'usage.reported' }>
): Promise<void> {
  const p = event.payload;
  const identity = {
    goal_id: goalId, provider: p.provider, model: p.model,
    session_id: event.source.sessionId, execution_id: event.source.executionId,
    attempt_id: event.source.attemptId,
  };
  let values = tokenValues(p);
  if (p.cumulative) {
    const previous = await trx('goal_usage_watermarks').where(identity).first();
    values = {
      input_tokens: Math.max(0, values.input_tokens - Number(previous?.input_tokens ?? 0)),
      output_tokens: Math.max(0, values.output_tokens - Number(previous?.output_tokens ?? 0)),
      cache_read_tokens: Math.max(0, values.cache_read_tokens - Number(previous?.cache_read_tokens ?? 0)),
      cache_write_tokens: Math.max(0, values.cache_write_tokens - Number(previous?.cache_write_tokens ?? 0)),
      reasoning_tokens: Math.max(0, values.reasoning_tokens - Number(previous?.reasoning_tokens ?? 0)),
    };
    await trx('goal_usage_watermarks').insert({ ...identity, ...tokenValues(p) })
      .onConflict(Object.keys(identity)).merge(tokenValues(p));
  }
  await trx('goal_usage_occurrences').insert({
    ...identity, occurrence_id: p.occurrenceId, ...values,
    event_sequence: sequence, created_at: nowIso(),
  }).onConflict([
    'goal_id', 'provider', 'model', 'session_id', 'execution_id', 'attempt_id', 'occurrence_id',
  ]).ignore();
}

function tokenValues(payload: DurableGoalEventPayloadMap['usage.reported']) {
  return {
    input_tokens: payload.inputTokens, output_tokens: payload.outputTokens,
    cache_read_tokens: payload.cacheReadTokens, cache_write_tokens: payload.cacheWriteTokens,
    reasoning_tokens: payload.reasoningTokens,
  };
}

function externalProjection(event: DurableGoalEventInput): { type: string; number: number; status: string } | null {
  if (event.type === 'github.entity_changed') return { type: event.payload.entity, number: event.payload.number, status: event.payload.status };
  if (event.type === 'ci.status_changed') return { type: 'ci', number: event.payload.pullRequestNumber, status: event.payload.status };
  if (event.type === 'review.status_changed') return { type: 'review', number: event.payload.pullRequestNumber, status: event.payload.status };
  if (event.type === 'ultrafix.status_changed') return { type: 'ultrafix', number: event.payload.pullRequestNumber, status: event.payload.status };
  return null;
}

async function findIdempotentEvent(trx: Knex.Transaction, goalId: string, key: string) {
  return trx<GoalEventRecord>('goal_events').where({ goal_id: goalId, idempotency_key: key }).first();
}

async function findSourceEvent(trx: Knex.Transaction, goalId: string, input: DurableGoalEventInput) {
  return trx<GoalEventRecord>('goal_events').where({
    goal_id: goalId, source_session_id: input.source.sessionId,
    source_turn_id: input.source.turnId, source_execution_id: input.source.executionId,
    source_attempt_id: input.source.attemptId,
    source_provider_sequence: input.source.providerSequence,
    source_chunk_index: input.source.chunkIndex, lease_generation: input.source.leaseGeneration,
  }).first();
}

function compareEvent(row: GoalEventRecord, kind: string, eventType: string, payloadJson: string | null): GoalEvent {
  if (row.kind !== kind || row.event_type !== eventType || canonicalizeStoredPayload(row.payload_json) !== payloadJson) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Event identity was reused with a different payload', 409);
  }
  return toEvent(row);
}

function compareTypedEvent(row: GoalEventRecord, input: DurableGoalEventInput, payloadJson: string): GoalEvent {
  if (row.event_type !== input.type || row.schema_version !== input.schemaVersion
    || canonicalizeStoredPayload(row.payload_json) !== payloadJson
    || row.source_session_id !== input.source.sessionId || row.source_turn_id !== input.source.turnId
    || row.source_execution_id !== input.source.executionId || row.source_attempt_id !== input.source.attemptId
    || row.source_provider_sequence !== input.source.providerSequence || row.source_chunk_index !== input.source.chunkIndex
    || row.lease_generation !== input.source.leaseGeneration) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Event identity was reused with different content', 409);
  }
  return toEvent(row);
}

function normalizeLegacyEvent(input: AppendEventInput): AppendEventInput & { payloadJson: string | null } {
  if (!GOAL_EVENT_KINDS.includes(input.kind)) throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Event kind is not recognized', 400);
  let payloadJson: string | null = null;
  if (Object.hasOwn(input, 'payload')) payloadJson = canonicalizePayload(input.payload);
  return {
    ...input, payloadJson,
    eventType: boundedText(input.eventType, 'eventType') as string,
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    leaseOwner: boundedText(input.leaseOwner, 'leaseOwner') as string,
  };
}

function canonicalizePayload(payload: unknown): string {
  try {
    const json = canonicalizeRuntimeJson(payload);
    if (Buffer.byteLength(json) > CANONICAL_JSON_MAX_BYTES) throw new Error('oversized');
    return json;
  } catch {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Event payload must be bounded lossless JSON', 400);
  }
}

function canonicalizeStoredPayload(payloadJson: string | null): string | null {
  if (payloadJson === null) return null;
  try {
    if (Buffer.byteLength(payloadJson) > CANONICAL_JSON_MAX_BYTES) throw new Error('oversized');
    return canonicalizeStoredJson(payloadJson);
  } catch {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Stored event payload is malformed', 409);
  }
}

function validateOutputChunk(payload: DurableGoalEventPayloadMap['provider.output'], payloadJson: string): void {
  const contentBytes = typeof payload.chunk === 'string' ? Buffer.byteLength(payload.chunk) : Buffer.byteLength(payloadJson);
  if (contentBytes > GOAL_OUTPUT_CHUNK_MAX_BYTES) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `Output chunk exceeds ${GOAL_OUTPUT_CHUNK_MAX_BYTES} bytes`, 400);
  }
  if (payload.outputType === 'text' && typeof payload.chunk !== 'string'
    || payload.outputType === 'json' && typeof payload.chunk === 'string'
    || payload.stream !== 'structured' && payload.outputType !== 'text') {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Output stream/type metadata does not match its chunk', 400);
  }
}

function validateSource(input: DurableGoalEventInput): void {
  for (const [field, value] of Object.entries({
    sessionId: input.source.sessionId, turnId: input.source.turnId,
    executionId: input.source.executionId, attemptId: input.source.attemptId,
  })) boundedText(value, `source.${field}`);
  for (const [field, value] of Object.entries({
    providerSequence: input.source.providerSequence, chunkIndex: input.source.chunkIndex,
    leaseGeneration: input.source.leaseGeneration,
  })) {
    if (!Number.isSafeInteger(value) || value < (field === 'leaseGeneration' ? 1 : 0)) {
      throw new GoalError(GOAL_ERROR_CODES.validation, `source.${field} is invalid`, 400);
    }
  }
  idempotencyKey(input.idempotencyKey);
}

function eventKind(type: DurableGoalEventType): 'lifecycle' | 'output' | 'domain' {
  if (type === 'lifecycle.state_changed') return 'lifecycle';
  if (type === 'provider.output') return 'output';
  return 'domain';
}

interface NormalizedMessage {
  messageId: string | null; body: string; cannedAction: GoalCannedAction | null;
  authorUserId: string; idempotencyKey: string;
}

function normalizeMessage(input: EnqueueMessageInput, defaultAuthor: string): NormalizedMessage {
  const canned = input.cannedAction ?? input.predefinedKind ?? null;
  if (canned !== null && !GOAL_CANNED_ACTIONS.includes(canned as GoalCannedAction)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'cannedAction is not recognized', 400);
  }
  const cannedAction = canned as GoalCannedAction | null;
  const suppliedBody = typeof input.body === 'string' && input.body.trim() ? input.body : null;
  if (!suppliedBody && !cannedAction) throw new GoalError(GOAL_ERROR_CODES.validation, 'body or cannedAction is required', 400);
  const resolved = suppliedBody ?? GOAL_CANNED_ACTION_TEXT[cannedAction!];
  return {
    messageId: boundedText(input.messageId, 'messageId', undefined, true),
    body: boundedText(resolved, 'body', GOAL_MESSAGE_BODY_MAX_LENGTH) as string,
    cannedAction, authorUserId: boundedText(input.authorUserId ?? defaultAuthor, 'authorUserId') as string,
    idempotencyKey: idempotencyKey(input.idempotencyKey),
  };
}

function compareMessage(row: GoalMessageRecord, input: NormalizedMessage): GoalMessage {
  if (row.message_id !== (input.messageId ?? row.message_id) || row.body !== input.body
    || (row.canned_action ?? row.predefined_kind) !== input.cannedAction
    || (row.author_user_id ?? input.authorUserId) !== input.authorUserId) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Message idempotency key was reused with a different payload', 409);
  }
  return toMessage(row);
}

async function requireMessage(trx: Knex.Transaction, goalId: string, messageId: string): Promise<GoalMessageRecord> {
  const message = await trx<GoalMessageRecord>('goal_messages').where({ goal_id: goalId, message_id: messageId }).first();
  if (!message) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal message not found', 404);
  return message;
}

async function nextLegacySequence(trx: Knex.Transaction, table: 'goal_events' | 'goal_messages', goalId: string): Promise<number> {
  const row = await trx(table).where('goal_id', goalId).max('sequence as maxSeq').first() as { maxSeq: number | null } | undefined;
  return (row?.maxSeq ?? 0) + 1;
}

function validateAfterSequence(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Event cursor must be a non-negative integer', 400);
  }
}

function validateKind(kind: string | undefined): void {
  if (kind !== undefined && !GOAL_EVENT_KINDS.includes(kind as typeof GOAL_EVENT_KINDS[number])) {
    throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Event kind is not recognized', 400);
  }
}

function validateLimit(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${max}`, 400);
  }
  return result;
}

function sanitizeError(value: string): string {
  if (typeof value !== 'string') return 'Provider delivery failed';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/(?:token|password|secret|key)\s*[=:]\s*\S+/gi, '[REDACTED]').trim().slice(0, 500)
    || 'Provider delivery failed';
}

function digestUnknown(value: unknown): string {
  let raw = '[unserializable]';
  try { raw = canonicalizeRuntimeJson(value); } catch { /* digest fixed marker */ }
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function safeQuarantineKey(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 255);
  return `invalid:${crypto.randomUUID()}`;
}

function requireEnhanced(value: boolean): void {
  if (!value) throw new GoalError(GOAL_ERROR_CODES.validation, 'Durable goal message migration is not installed', 503);
}

function messageConflict(message: string): GoalError {
  return new GoalError(GOAL_ERROR_CODES.messageOrderConflict, message, 409);
}
