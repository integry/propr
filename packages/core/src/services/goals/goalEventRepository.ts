import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_CURSOR_MAX_LENGTH, GOAL_ERROR_CODES, GOAL_EVENT_DEFAULT_LIMIT, GOAL_EVENT_DEFAULT_MAX_BYTES,
  GOAL_EVENT_MAX_BYTES, GOAL_EVENT_MAX_LIMIT, isDurableGoalEventType,
  validateDurableGoalEvent, type DurableGoalEventInput,
} from '@propr/shared';
import type {
  AppendEventInput, GoalEvent, GoalEventPageResult, GoalEventRecord,
  GoalLeaseFence, GoalProviderTodo,
} from './goalTypes.js';
import {
  GoalError, guardLease, goalTransaction, idempotencyKey, nowIso,
  requireGoalRecord, toEvent,
} from './goalRepositorySupport.js';
import { decodeGoalPageCursor, encodeGoalPageCursor } from './goalPageCursor.js';
import {
  allocateGoalEventSequence, ensureGoalEventState, type GoalEventStateRecord,
} from './goalEventWriter.js';
import {
  canonicalizePayload, compareEvent, compareTypedEvent, digestUnknown, eventKind,
  guardSourceIdentity, normalizeLegacyEvent, projectTypedEvent, safeQuarantineKey,
  validateAfterSequence, validateKind, validateLimit, validateOutputChunk, validateSource,
} from './goalEventIngestion.js';

export class GoalEventRepository {
  constructor(private readonly db: Knex) {}

  /** Explicit migration-only writer. Runtime callers must use appendTypedEvent. */
  async appendMigrationEvent(goalId: string, input: AppendEventInput): Promise<GoalEvent> {
    const normalized = normalizeLegacyEvent(input);
    if (await this.hasEnhancedSchema()) {
      throw new GoalError(
        GOAL_ERROR_CODES.validation,
        'Arbitrary event ingestion is sealed after the durable replay migration',
        410
      );
    }
    return goalTransaction(this.db, async trx => {
      const goal = await guardLease(trx, goalId, normalized);
      const existing = await findIdempotentEvent(trx, goalId, normalized.idempotencyKey);
      if (existing) {
        return compareEvent(existing, normalized.kind, normalized.eventType, normalized.payloadJson);
      }
      const sequence = await nextLegacySequence(trx, goalId);
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

  async appendTypedEvent(goalId: string, input: unknown): Promise<GoalEvent> {
    if (!await this.hasEnhancedSchema()) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'Durable goal event migration is not installed', 503);
    }
    const validation = validateDurableGoalEvent(input);
    if (!validation.ok) {
      await this.quarantineMalformed(goalId, input, validation.error ?? 'invalid event');
      const candidate = input as Partial<DurableGoalEventInput> | null;
      throw new GoalError(
        typeof candidate?.type === 'string' && !isDurableGoalEventType(candidate.type)
          ? GOAL_ERROR_CODES.invalidEventKind : GOAL_ERROR_CODES.validation,
        validation.error ?? 'Durable event is invalid',
        400
      );
    }
    const typed = input as DurableGoalEventInput;
    if (typed.type === 'provider.output_compacted') {
      throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Compaction tombstones are repository-authored only', 400);
    }
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
      const sequence = await allocateGoalEventSequence(trx, goalId);
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
      await projectTypedEvent(trx, { goalId, sequence, createdAt }, typed);
      await trx('goal_event_state').where('goal_id', goalId).update({
        projection_sequence: sequence, updated_at: createdAt,
      });
      return toEvent({ ...record, id: id as number });
    });
  }

  async readEvents(
    goalId: string,
    options: { afterSequence?: number; limit?: number; kind?: string } = {}
  ): Promise<{ events: GoalEvent[]; nextCursor: number | null }> {
    validateAfterSequence(options.afterSequence);
    validateKind(options.kind);
    const limit = validateLimit(options.limit, GOAL_EVENT_DEFAULT_LIMIT, GOAL_EVENT_MAX_LIMIT);
    let query = this.db<GoalEventRecord>('goal_events').where('goal_id', goalId);
    if (options.afterSequence !== undefined) query = query.andWhere('sequence', '>', options.afterSequence);
    if (options.kind) query = query.andWhere('kind', options.kind);
    const rows = await query.orderBy('sequence', 'asc').limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      events: page.map(toEvent),
      nextCursor: rows.length > limit && page.length > 0 ? page.at(-1)!.sequence : null,
    };
  }

  async readEventPage(
    goalId: string,
    options: {
      cursor?: string | null; afterSequence?: number; limit?: number;
      maxBytes?: number; kind?: string;
    } = {}
  ): Promise<GoalEventPageResult> {
    const pageOptions = normalizePageOptions(options);
    const goal = await requireGoalRecord(this.db, goalId);
    const binding = {
      type: 'goal-events' as const, goalId, ownerUserId: goal.owner_user_id,
      repository: goal.repository, filter: pageOptions.kind ?? null,
    };
    const cursor = decodeGoalPageCursor(pageOptions.cursor, binding);
    const state = await this.eventState(goalId);
    const after = cursor?.sequence ?? pageOptions.afterSequence ?? state.min_retained_sequence - 1;
    if ((cursor || pageOptions.afterSequence !== undefined) && after < state.min_retained_sequence - 1) {
      throw new GoalError(GOAL_ERROR_CODES.cursorExpired, 'Goal event cursor expired', 410);
    }
    let query = this.db<GoalEventRecord>('goal_events').where('goal_id', goalId)
      .andWhere('sequence', '>', after).andWhere('sequence', '<=', state.high_watermark);
    if (pageOptions.kind) query = query.andWhere('kind', pageOptions.kind);
    const rows = await query.orderBy('sequence', 'asc').limit(pageOptions.limit + 1);
    const page = fitSerializedPage(rows.slice(0, pageOptions.limit), pageOptions.maxBytes);
    const last = page.at(-1);
    const hasMore = Boolean(last) && (page.length < rows.length
      || await this.hasEventAfter(goalId, last!.sequence, state.high_watermark, pageOptions.kind));
    const rowCursor = (row: GoalEventRecord) => encodeGoalPageCursor(binding, {
      sequence: row.sequence, createdAt: row.created_at,
    });
    return {
      events: page.map(row => ({ ...toEvent(row), cursor: rowCursor(row) })),
      nextCursor: hasMore && last ? rowCursor(last) : null,
      lastCursor: last ? rowCursor(last) : pageOptions.cursor ?? null,
      asOfSequence: state.high_watermark,
    };
  }

  async getLatestSequence(goalId: string): Promise<number> {
    if (await this.hasEnhancedSchema()) return (await this.eventState(goalId)).high_watermark;
    const row = await this.db('goal_events').where('goal_id', goalId)
      .max('sequence as value').first() as { value?: number };
    return Number(row?.value ?? 0);
  }

  async getProviderTodos(goalId: string): Promise<GoalProviderTodo[]> {
    if (!await this.db.schema.hasTable('goal_provider_todos')) return [];
    const rows = await this.db('goal_provider_todos').where('goal_id', goalId)
      .orderBy('event_sequence', 'asc').orderBy('todo_id', 'asc');
    return rows.map(row => ({
      sessionId: String(row.session_id), todoId: String(row.todo_id), body: String(row.body),
      status: row.status as GoalProviderTodo['status'], eventSequence: Number(row.event_sequence),
    }));
  }

  async compactOutput(goalId: string, throughSequence: number, fence: GoalLeaseFence): Promise<void> {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
      throw new GoalError(GOAL_ERROR_CODES.validation, 'throughSequence must be a positive integer', 400);
    }
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, goalId, fence);
      const state = await trx<GoalEventStateRecord>('goal_event_state').where('goal_id', goalId).first();
      if (!state || throughSequence > state.high_watermark) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'Compaction boundary exceeds the event watermark', 400);
      }
      if (throughSequence <= state.checkpoint_sequence) return;
      const rows = await trx<GoalEventRecord>('goal_events').where('goal_id', goalId)
        .andWhere('sequence', '<=', throughSequence).andWhere('event_type', 'provider.output')
        .orderBy('sequence', 'asc');
      await replaceOutputWithTombstones(trx, rows);
      const aggregate = compactionAggregate(rows);
      await trx('goal_compaction_checkpoints').insert({
        goal_id: goalId, through_sequence: throughSequence, ...aggregate, created_at: nowIso(),
      }).onConflict(['goal_id', 'through_sequence']).ignore();
      await trx('goal_event_state').where('goal_id', goalId).update({
        checkpoint_sequence: throughSequence, updated_at: nowIso(),
      });
    });
  }

  private hasEnhancedSchema(): Promise<boolean> {
    return this.db.schema.hasTable('goal_event_state');
  }

  private async eventState(goalId: string): Promise<GoalEventStateRecord> {
    if (!await this.hasEnhancedSchema()) {
      const row = await this.db('goal_events').where('goal_id', goalId)
        .max('sequence as value').first() as { value?: number };
      const highWatermark = Number(row?.value ?? 0);
      return {
        goal_id: goalId, high_watermark: highWatermark, min_retained_sequence: 1,
        projection_sequence: highWatermark, checkpoint_sequence: 0,
      };
    }
    let state = await this.db<GoalEventStateRecord>('goal_event_state').where('goal_id', goalId).first();
    if (!state) {
      await goalTransaction(this.db, trx => ensureGoalEventState(trx, goalId));
      state = await this.db<GoalEventStateRecord>('goal_event_state').where('goal_id', goalId).first();
    }
    if (!state) throw new Error(`Missing event state for goal ${goalId}`);
    return state;
  }

  private async hasEventAfter(goalId: string, after: number, high: number, kind?: string) {
    let query = this.db('goal_events').where('goal_id', goalId)
      .andWhere('sequence', '>', after).andWhere('sequence', '<=', high);
    if (kind) query = query.andWhere('kind', kind);
    return Boolean(await query.first('sequence'));
  }

  private async quarantineMalformed(goalId: string, input: unknown, reason: string): Promise<void> {
    const candidate = input as Partial<DurableGoalEventInput> | null;
    if (!candidate || typeof candidate !== 'object'
      || typeof candidate.leaseOwner !== 'string' || !Number.isSafeInteger(candidate.leaseEpoch)) return;
    await goalTransaction(this.db, async trx => {
      await guardLease(trx, goalId, candidate as GoalLeaseFence);
      await trx('goal_event_quarantine').insert({
        goal_id: goalId, idempotency_key: safeQuarantineKey(candidate.idempotencyKey),
        event_type: typeof candidate.type === 'string' ? candidate.type.slice(0, 255) : null,
        reason: reason.slice(0, 500), payload_digest: digestUnknown(input), created_at: nowIso(),
      }).onConflict(['goal_id', 'idempotency_key']).ignore();
    });
  }
}

function normalizePageOptions(options: {
  cursor?: string | null; afterSequence?: number; limit?: number; maxBytes?: number; kind?: string;
}) {
  validateAfterSequence(options.afterSequence);
  validateKind(options.kind);
  if (options.cursor && options.afterSequence !== undefined) {
    throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'cursor and afterSequence cannot be combined', 400);
  }
  return {
    ...options,
    limit: validateLimit(options.limit, GOAL_EVENT_DEFAULT_LIMIT, GOAL_EVENT_MAX_LIMIT),
    maxBytes: validateLimit(options.maxBytes, GOAL_EVENT_DEFAULT_MAX_BYTES, GOAL_EVENT_MAX_BYTES),
  };
}

function fitSerializedPage(rows: GoalEventRecord[], maxBytes: number): GoalEventRecord[] {
  const page: GoalEventRecord[] = [];
  let bytes = Buffer.byteLength('{"schemaVersion":1,"events":[],"nextCursor":null,"asOfSequence":0}');
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(toEvent(row))) + GOAL_CURSOR_MAX_LENGTH + 128
      + (page.length > 0 ? 1 : 0);
    if (bytes + rowBytes > maxBytes) {
      if (page.length === 0) {
        throw new GoalError(
          GOAL_ERROR_CODES.replayItemTooLarge,
          `Next event requires ${bytes + rowBytes} serialized bytes; increase maxBytes or compact output`,
          413
        );
      }
      break;
    }
    page.push(row);
    bytes += rowBytes;
  }
  return page;
}

async function replaceOutputWithTombstones(trx: Knex.Transaction, rows: GoalEventRecord[]) {
  for (const row of rows) {
    const payloadBytes = row.payload_bytes ?? Buffer.byteLength(row.payload_json ?? '');
    const tombstone = canonicalizePayload({
      originalType: 'provider.output',
      contentDigest: crypto.createHash('sha256').update(row.payload_json ?? '').digest('hex'),
      payloadBytes,
    });
    await trx('goal_events').where({ id: row.id, event_type: 'provider.output' }).update({
      event_type: 'provider.output_compacted', kind: 'output', payload_json: tombstone,
      payload_bytes: Buffer.byteLength(tombstone),
    });
  }
}

function compactionAggregate(rows: GoalEventRecord[]) {
  const digest = crypto.createHash('sha256');
  let removedPayloadBytes = 0;
  for (const row of rows) {
    digest.update(`${row.sequence}:${row.payload_json ?? ''}\n`);
    removedPayloadBytes += row.payload_bytes ?? Buffer.byteLength(row.payload_json ?? '');
  }
  return {
    content_digest: digest.digest('hex'), removed_event_count: rows.length,
    removed_payload_bytes: removedPayloadBytes,
  };
}

function findIdempotentEvent(trx: Knex.Transaction, goalId: string, key: string) {
  return trx<GoalEventRecord>('goal_events').where({ goal_id: goalId, idempotency_key: key }).first();
}

function findSourceEvent(trx: Knex.Transaction, goalId: string, input: DurableGoalEventInput) {
  return trx<GoalEventRecord>('goal_events').where({
    goal_id: goalId, source_session_id: input.source.sessionId,
    source_turn_id: input.source.turnId, source_execution_id: input.source.executionId,
    source_attempt_id: input.source.attemptId,
    source_provider_sequence: input.source.providerSequence,
    source_chunk_index: input.source.chunkIndex, lease_generation: input.source.leaseGeneration,
  }).first();
}

async function nextLegacySequence(trx: Knex.Transaction, goalId: string): Promise<number> {
  const row = await trx('goal_events').where('goal_id', goalId)
    .max('sequence as value').first() as { value?: number };
  return Number(row?.value ?? 0) + 1;
}
