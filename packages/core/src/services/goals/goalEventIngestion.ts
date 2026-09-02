import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_ERROR_CODES, GOAL_EVENT_KINDS, GOAL_OUTPUT_CHUNK_MAX_BYTES,
  type DurableGoalEventInput, type DurableGoalEventPayloadMap, type DurableGoalEventType,
} from '@propr/shared';
import type { AppendEventInput, GoalEvent, GoalEventRecord, GoalProviderSessionRecord } from './goalTypes.js';
import { GoalError, boundedText, idempotencyKey, nowIso } from './goalRepositorySupport.js';
import {
  CANONICAL_JSON_MAX_BYTES, canonicalizeRuntimeJson, canonicalizeStoredJson,
} from './strictCanonicalJson.js';

export async function guardSourceIdentity(
  trx: Knex.Transaction,
  goalId: string,
  input: DurableGoalEventInput
): Promise<void> {
  const session = await trx<GoalProviderSessionRecord>('goal_provider_sessions').where({
    goal_id: goalId, session_id: input.source.sessionId,
  }).first();
  if (!session || session.lease_generation !== input.source.leaseGeneration
    || input.source.leaseGeneration !== input.leaseEpoch
    || session.current_turn_id !== input.source.turnId
    || session.current_execution_id !== input.source.executionId
    || session.current_attempt_id !== input.source.attemptId) {
    throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Provider source identity is stale', 409);
  }
}

export async function projectTypedEvent(
  trx: Knex.Transaction,
  coordinates: { goalId: string; sequence: number; createdAt: string },
  event: DurableGoalEventInput
): Promise<void> {
  if (event.type === 'usage.reported') {
    await projectUsage(trx, coordinates.goalId, coordinates.sequence, event);
    return;
  }
  if (event.type === 'provider.todo') {
    await trx('goal_provider_todos').where({
      goal_id: coordinates.goalId, session_id: event.source.sessionId,
    }).delete();
    await Promise.all(event.payload.items.map(item => trx('goal_provider_todos').insert({
      goal_id: coordinates.goalId, session_id: event.source.sessionId, todo_id: item.id,
      body: item.text, status: item.status, event_sequence: coordinates.sequence,
    })));
    return;
  }
  const external = externalProjection(event);
  if (!external) return;
  await trx('goal_external_projections').insert({
    goal_id: coordinates.goalId, entity_type: external.type, entity_number: external.number,
    status: external.status, event_sequence: coordinates.sequence, updated_at: coordinates.createdAt,
  }).onConflict(['goal_id', 'entity_type', 'entity_number']).merge({
    status: external.status, event_sequence: coordinates.sequence, updated_at: coordinates.createdAt,
  });
}

async function projectUsage(
  trx: Knex.Transaction,
  goalId: string,
  sequence: number,
  event: Extract<DurableGoalEventInput, { type: 'usage.reported' }>
): Promise<void> {
  const payload = event.payload;
  const occurrenceIdentity = {
    goal_id: goalId, session_id: event.source.sessionId,
    execution_id: event.source.executionId, attempt_id: event.source.attemptId,
    occurrence_id: payload.occurrenceId,
  };
  const contentDigest = crypto.createHash('sha256')
    .update(canonicalizePayload(payload)).digest('hex');
  const duplicate = await trx('goal_usage_occurrences').where(occurrenceIdentity).first();
  if (duplicate) {
    if (duplicate.content_digest !== contentDigest) {
      throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Usage occurrence was reused with different content', 409);
    }
    return;
  }
  let values = tokenValues(payload);
  if (payload.cumulative) {
    const watermarkIdentity = {
      goal_id: goalId, session_id: event.source.sessionId,
      execution_id: event.source.executionId, attempt_id: event.source.attemptId,
    };
    const previous = await trx('goal_usage_watermarks').where(watermarkIdentity).first();
    const projected = projectCumulativeUsage(previous, values, event.source.providerSequence);
    values = projected.delta;
    if (previous) {
      await trx('goal_usage_watermarks').where({
        ...watermarkIdentity, provider: previous.provider, model: previous.model,
      }).update(projected.watermark);
    } else {
      await trx('goal_usage_watermarks').insert({
        ...watermarkIdentity, provider: payload.provider, model: payload.model, ...projected.watermark,
      });
    }
  }
  await trx('goal_usage_occurrences').insert({
    ...occurrenceIdentity, provider: payload.provider, model: payload.model, ...values,
    reported_input_tokens: payload.inputTokens, reported_output_tokens: payload.outputTokens,
    reported_cache_read_tokens: payload.cacheReadTokens,
    reported_cache_write_tokens: payload.cacheWriteTokens,
    reported_reasoning_tokens: payload.reasoningTokens, cumulative: payload.cumulative ? 1 : 0,
    content_digest: contentDigest, provider_sequence: event.source.providerSequence,
    event_sequence: sequence, created_at: nowIso(),
  });
}

const USAGE_FIELDS = [
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
] as const;

function projectCumulativeUsage(
  previous: Record<string, unknown> | undefined,
  report: ReturnType<typeof tokenValues>,
  providerSequence: number
): { delta: ReturnType<typeof tokenValues>; watermark: Record<string, number> } {
  const delta = {} as ReturnType<typeof tokenValues>;
  const watermark: Record<string, number> = {};
  for (const field of USAGE_FIELDS) {
    const oldValue = Number(previous?.[field] ?? 0);
    const oldSequence = Number(previous?.[`${field}_sequence`] ?? -1);
    const ordered = providerSequence > oldSequence;
    const nextValue = ordered ? Math.max(oldValue, report[field]) : oldValue;
    delta[field] = ordered ? nextValue - oldValue : 0;
    watermark[field] = nextValue;
    watermark[`${field}_sequence`] = ordered ? providerSequence : oldSequence;
  }
  return { delta, watermark };
}

function tokenValues(payload: DurableGoalEventPayloadMap['usage.reported']) {
  return {
    input_tokens: payload.inputTokens, output_tokens: payload.outputTokens,
    cache_read_tokens: payload.cacheReadTokens, cache_write_tokens: payload.cacheWriteTokens,
    reasoning_tokens: payload.reasoningTokens,
  };
}

function externalProjection(event: DurableGoalEventInput): { type: string; number: number; status: string } | null {
  if (event.type === 'github.entity_changed') {
    return { type: event.payload.entity, number: event.payload.number, status: event.payload.status };
  }
  if (event.type === 'ci.status_changed') return { type: 'ci', number: event.payload.pullRequestNumber, status: event.payload.status };
  if (event.type === 'review.status_changed') return { type: 'review', number: event.payload.pullRequestNumber, status: event.payload.status };
  if (event.type === 'ultrafix.status_changed') return { type: 'ultrafix', number: event.payload.pullRequestNumber, status: event.payload.status };
  return null;
}

export function compareEvent(
  row: GoalEventRecord,
  kind: string,
  eventType: string,
  payloadJson: string | null
): GoalEvent {
  if (row.kind !== kind || row.event_type !== eventType
    || canonicalizeStoredPayload(row.payload_json) !== payloadJson) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Event identity was reused with a different payload', 409);
  }
  return toDomainEvent(row);
}

export function compareTypedEvent(
  row: GoalEventRecord,
  input: DurableGoalEventInput,
  payloadJson: string
): GoalEvent {
  if (row.event_type === 'provider.output_compacted' && input.type === 'provider.output') {
    const tombstone = JSON.parse(row.payload_json ?? '{}') as { contentDigest?: unknown };
    if (tombstone.contentDigest === crypto.createHash('sha256').update(payloadJson).digest('hex')
      && sameSourceIdentity(row, input)) return toDomainEvent(row);
  }
  if (row.event_type !== input.type || row.schema_version !== input.schemaVersion
    || canonicalizeStoredPayload(row.payload_json) !== payloadJson || !sameSourceIdentity(row, input)) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Event identity was reused with different content', 409);
  }
  return toDomainEvent(row);
}

function toDomainEvent(row: GoalEventRecord): GoalEvent {
  return {
    id: row.id, goalId: row.goal_id, sequence: row.sequence, kind: row.kind,
    eventType: row.event_type, payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key, leaseEpoch: row.lease_epoch,
    createdAt: row.created_at, schemaVersion: row.schema_version ?? 1, cursor: null,
  };
}

function sameSourceIdentity(row: GoalEventRecord, input: DurableGoalEventInput): boolean {
  return row.source_session_id === input.source.sessionId && row.source_turn_id === input.source.turnId
    && row.source_execution_id === input.source.executionId && row.source_attempt_id === input.source.attemptId
    && row.source_provider_sequence === input.source.providerSequence
    && row.source_chunk_index === input.source.chunkIndex
    && row.lease_generation === input.source.leaseGeneration;
}

export function normalizeLegacyEvent(input: AppendEventInput): AppendEventInput & { payloadJson: string | null } {
  if (!GOAL_EVENT_KINDS.includes(input.kind)) {
    throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Event kind is not recognized', 400);
  }
  return {
    ...input,
    payloadJson: Object.hasOwn(input, 'payload') ? canonicalizePayload(input.payload) : null,
    eventType: boundedText(input.eventType, 'eventType') as string,
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    leaseOwner: boundedText(input.leaseOwner, 'leaseOwner') as string,
  };
}

export function canonicalizePayload(payload: unknown): string {
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

export function validateOutputChunk(
  payload: DurableGoalEventPayloadMap['provider.output'],
  payloadJson: string
): void {
  const bytes = typeof payload.chunk === 'string' ? Buffer.byteLength(payload.chunk) : Buffer.byteLength(payloadJson);
  if (bytes > GOAL_OUTPUT_CHUNK_MAX_BYTES) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `Output chunk exceeds ${GOAL_OUTPUT_CHUNK_MAX_BYTES} bytes`, 400);
  }
  if (payload.outputType === 'text' && typeof payload.chunk !== 'string'
    || payload.outputType === 'json' && typeof payload.chunk === 'string'
    || payload.stream !== 'structured' && payload.outputType !== 'text') {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Output stream/type metadata does not match its chunk', 400);
  }
}

export function validateSource(input: DurableGoalEventInput): void {
  for (const [field, value] of Object.entries({
    sessionId: input.source.sessionId, turnId: input.source.turnId,
    executionId: input.source.executionId, attemptId: input.source.attemptId,
  })) boundedText(value, `source.${field}`);
  idempotencyKey(input.idempotencyKey);
}

export function eventKind(type: DurableGoalEventType): 'lifecycle' | 'output' | 'domain' {
  if (type === 'lifecycle.state_changed') return 'lifecycle';
  return type === 'provider.output' || type === 'provider.output_compacted' ? 'output' : 'domain';
}

export function validateAfterSequence(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Event cursor must be a non-negative integer', 400);
  }
}

export function validateKind(kind: string | undefined): void {
  if (kind !== undefined && !GOAL_EVENT_KINDS.includes(kind as typeof GOAL_EVENT_KINDS[number])) {
    throw new GoalError(GOAL_ERROR_CODES.invalidEventKind, 'Event kind is not recognized', 400);
  }
}

export function validateLimit(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${max}`, 400);
  }
  return result;
}

export function digestUnknown(value: unknown): string {
  let raw = '[unserializable]';
  try { raw = canonicalizeRuntimeJson(value); } catch { /* digest fixed marker */ }
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function safeQuarantineKey(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 255);
  return `invalid:${crypto.randomUUID()}`;
}
