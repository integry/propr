import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_CURSOR_MAX_LENGTH,
  GOAL_ERROR_CODES,
  GOAL_IDENTIFIER_MAX_LENGTH,
  GOAL_IDEMPOTENCY_KEY_MAX_LENGTH,
  GOAL_REASON_MAX_LENGTH,
  TERMINAL_GOAL_STATES,
  isTerminalGoalState,
  type GoalErrorCode,
  type GoalSummaryView,
} from '@propr/shared';
import type {
  Goal,
  GoalEvent,
  GoalEventRecord,
  GoalIdempotencyRecord,
  GoalLeaseFence,
  GoalMessage,
  GoalMessageRecord,
  GoalNode,
  GoalNodeRecord,
  GoalRecord,
} from './goalTypes.js';

export class GoalError extends Error {
  readonly code: GoalErrorCode;
  readonly status: number;

  constructor(code: GoalErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GoalError';
    this.code = code;
    this.status = status;
  }
}

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

export function characterLength(value: string): number {
  return Array.from(value).length;
}

export function boundedText(
  value: unknown,
  field: string,
  maxLength = GOAL_IDENTIFIER_MAX_LENGTH,
  allowNull = false
): string | null {
  if (allowNull && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a string`, 400);
  }
  const normalized = value.trim();
  if (!normalized || characterLength(normalized) > maxLength) {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      `${field} must contain between 1 and ${maxLength} characters`,
      400
    );
  }
  return normalized;
}

export function optionalReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, 'reason', GOAL_REASON_MAX_LENGTH) as string;
}

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GoalError(
      GOAL_ERROR_CODES.invalidIdempotencyKey,
      'A valid Idempotency-Key is required',
      400
    );
  }
  const normalized = value.trim();
  if (!normalized || characterLength(normalized) > GOAL_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new GoalError(
      GOAL_ERROR_CODES.invalidIdempotencyKey,
      `Idempotency-Key must contain between 1 and ${GOAL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      400
    );
  }
  return normalized;
}

export function toGoal(row: GoalRecord): Goal {
  return {
    goalId: row.goal_id, ownerUserId: row.owner_user_id,
    repository: row.repository, objective: row.objective, state: row.state,
    agent: row.agent, requestedModel: row.requested_model,
    effectiveModel: row.effective_model, maxActiveTasks: row.max_active_tasks,
    ultrafixEnabled: Boolean(row.ultrafix_enabled), ultrafixGoal: row.ultrafix_goal,
    ultrafixMaxCycles: row.ultrafix_max_cycles, mergePolicy: row.merge_policy,
    version: row.version, leaseOwner: row.lease_owner, leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at, terminalReason: row.terminal_reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function toNode(row: GoalNodeRecord): GoalNode {
  return {
    nodeId: row.node_id, goalId: row.goal_id, parentNodeId: row.parent_node_id,
    kind: row.kind, idempotencyKey: row.idempotency_key,
    externalRef: row.external_ref, externalKind: row.external_kind,
    title: row.title, status: row.status, attemptCount: row.attempt_count,
    orderIndex: row.order_index, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function toEvent(row: GoalEventRecord): GoalEvent {
  return {
    id: row.id, goalId: row.goal_id, sequence: row.sequence, kind: row.kind,
    eventType: row.event_type,
    payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key, leaseEpoch: row.lease_epoch,
    createdAt: row.created_at,
    schemaVersion: row.schema_version ?? 1,
    cursor: null,
  };
}

export function toMessage(row: GoalMessageRecord): GoalMessage {
  return {
    messageId: row.message_id, goalId: row.goal_id, sequence: row.sequence,
    body: row.body, predefinedKind: row.predefined_kind, state: row.state,
    deliveredAt: row.delivered_at, acknowledgedAt: row.acknowledged_at,
    deliveryAttempts: row.delivery_attempts, lastError: row.last_error,
    idempotencyKey: row.idempotency_key, createdAt: row.created_at,
    queueOrdinal: row.queue_ordinal ?? row.sequence,
    cannedAction: row.canned_action ?? null,
    authorUserId: row.author_user_id ?? null,
    claimedBy: row.claimed_by ?? null,
    claimedControllerId: row.claimed_controller_id ?? null,
    claimedTurnId: row.claimed_turn_id ?? null,
    claimedExecutionId: row.claimed_execution_id ?? null,
    claimedAttemptId: row.claimed_attempt_id ?? null,
    claimedProviderSequence: row.claimed_provider_sequence ?? null,
    claimedChunkIndex: row.claimed_chunk_index ?? null,
    claimedLeaseGeneration: row.claimed_lease_generation ?? null,
    deliveryKey: row.delivery_key ?? null,
    providerIdempotencyKey: row.provider_idempotency_key ?? null,
    claimedAt: row.claimed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    failedAt: row.failed_at ?? null,
    retryCount: row.retry_count ?? 0,
    enqueueEventSequence: row.enqueue_event_sequence ?? null,
    stateEventSequence: row.state_event_sequence ?? null,
  };
}

export interface GoalSummaryRecord extends GoalRecord {
  latest_sequence: number;
}

export function toSummary(row: GoalSummaryRecord): GoalSummaryView {
  const goal = toGoal(row);
  return {
    goalId: goal.goalId, state: goal.state, objective: goal.objective,
    repository: goal.repository, agent: goal.agent,
    requestedModel: goal.requestedModel, effectiveModel: goal.effectiveModel,
    maxActiveTasks: goal.maxActiveTasks, mergePolicy: goal.mergePolicy,
    ultrafixEnabled: goal.ultrafixEnabled, ultrafixGoal: goal.ultrafixGoal,
    ultrafixMaxCycles: goal.ultrafixMaxCycles, version: goal.version,
    latestSequence: Number(row.latest_sequence), createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export async function requireGoalRecord(
  trx: Knex | Knex.Transaction,
  goalId: string
): Promise<GoalRecord> {
  const id = boundedText(goalId, 'goalId') as string;
  const row = await trx<GoalRecord>('goals').where('goal_id', id).first();
  if (!row) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
  return row;
}

export function validateFence(fence: GoalLeaseFence): void {
  boundedText(fence.leaseOwner, 'leaseOwner');
  if (!Number.isSafeInteger(fence.leaseEpoch) || fence.leaseEpoch < 1) {
    throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Lease epoch must be a positive safe integer', 409);
  }
}

export async function guardLease(
  trx: Knex.Transaction,
  goalId: string,
  fence: GoalLeaseFence,
  version?: number
): Promise<GoalRecord> {
  const id = boundedText(goalId, 'goalId') as string;
  validateFence(fence);
  const now = nowIso();
  let update = trx('goals').where({
    goal_id: id,
    lease_owner: fence.leaseOwner,
    lease_epoch: fence.leaseEpoch,
  }).whereNotIn('state', TERMINAL_GOAL_STATES)
    .whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now);
  if (version !== undefined) update = update.andWhere('version', version);
  const affected = await update.update({ updated_at: trx.ref('updated_at') });
  if (affected !== 1) {
    const goal = await trx<GoalRecord>('goals').where('goal_id', id).first();
    if (!goal) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
    if (isTerminalGoalState(goal.state)) {
      throw new GoalError(GOAL_ERROR_CODES.terminalState, 'Terminal goals reject controller writes', 409);
    }
    throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Controller lease is stale or expired', 409);
  }
  return requireGoalRecord(trx, id);
}

interface IdempotentRun<T> {
  db: Knex;
  ownerUserId: string;
  operation: string;
  key: string;
  request: unknown;
  goalId: string | null;
  effect: (trx: Knex.Transaction) => Promise<T>;
}

export interface IdempotentReplay {
  ownerUserId: string;
  operation: string;
  key: string;
  request: unknown;
}

/**
 * Read a durable response without reserving a new key. This lets API callers
 * replay completed work before consulting mutable authorization or catalogs.
 */
export async function readIdempotentReplay<T>(
  db: Knex,
  options: IdempotentReplay
): Promise<T | null> {
  const ownerUserId = boundedText(options.ownerUserId, 'ownerUserId') as string;
  const operation = boundedText(options.operation, 'operation', 512) as string;
  const key = idempotencyKey(options.key);
  const row = await db<GoalIdempotencyRecord>('goal_idempotency_keys').where({
    owner_user_id: ownerUserId,
    operation,
    idempotency_key: key,
  }).first();
  if (!row) return null;
  if (row.request_hash !== hashRequest(options.request)) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Idempotency key was reused with a different payload', 409);
  }
  if (row.response_json === null) {
    throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Idempotent request is already in progress', 409);
  }
  return JSON.parse(row.response_json) as T;
}

export async function runIdempotent<T>(options: IdempotentRun<T>): Promise<T> {
  const key = idempotencyKey(options.key);
  const requestHash = hashRequest(options.request);
  const claimToken = crypto.randomUUID();
  return goalTransaction(options.db, async (trx) => {
    await trx('goal_idempotency_keys').insert({
      owner_user_id: boundedText(options.ownerUserId, 'ownerUserId'),
      operation: boundedText(options.operation, 'operation', 512),
      idempotency_key: key,
      request_hash: requestHash,
      claim_token: claimToken,
      goal_id: null,
      response_json: null,
      created_at: nowIso(),
    }).onConflict(['owner_user_id', 'operation', 'idempotency_key']).ignore();
    const row = await trx<GoalIdempotencyRecord>('goal_idempotency_keys').where({
      owner_user_id: options.ownerUserId,
      operation: options.operation,
      idempotency_key: key,
    }).first();
    if (!row || row.request_hash !== requestHash) {
      throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Idempotency key was reused with a different payload', 409);
    }
    if (row.claim_token !== claimToken) {
      if (row.response_json === null) {
        throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Idempotent request is already in progress', 409);
      }
      return JSON.parse(row.response_json) as T;
    }
    const response = await options.effect(trx);
    const updated = await trx('goal_idempotency_keys').where({
      owner_user_id: options.ownerUserId,
      operation: options.operation,
      idempotency_key: key,
      claim_token: claimToken,
    }).update({ goal_id: options.goalId ?? responseGoalId(response), response_json: JSON.stringify(response), claim_token: null });
    if (updated !== 1) throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'Idempotency ownership changed', 409);
    return response;
  });
}

/**
 * better-sqlite3 waits synchronously for a WAL writer. In one Node process that
 * can temporarily prevent the winning async transaction from reaching commit,
 * so release the event loop and retry a bounded number of times.
 */
export async function goalTransaction<T>(
  db: Knex,
  effect: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await db.transaction(effect);
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new GoalError(GOAL_ERROR_CODES.versionConflict, 'Goal write contention could not be resolved', 409);
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function responseGoalId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const goalId = (response as { goalId?: unknown }).goalId;
  return typeof goalId === 'string' ? goalId : null;
}

export function hashRequest(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface Cursor { createdAt: string; goalId: string }
export interface GoalListCursorBinding {
  ownerUserId: string | null;
  repository?: string;
  state?: string;
  search?: string;
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function cursorJson(createdAt: string, goalId: string, binding: GoalListCursorBinding): string {
  return JSON.stringify({
    v: 1,
    t: 'goal-list',
    o: binding.ownerUserId,
    r: binding.repository ?? null,
    st: binding.state ?? null,
    q: binding.search ?? null,
    a: createdAt,
    g: goalId,
  });
}

export function encodeCursor(
  createdAt: string,
  goalId: string,
  binding: GoalListCursorBinding
): string {
  if (!canonicalInstant(createdAt)) invalidCursor();
  return Buffer.from(cursorJson(createdAt, goalId, binding), 'utf8').toString('base64url');
}

export function decodeCursor(
  value: string | null | undefined,
  binding: GoalListCursorBinding
): Cursor | null {
  if (value === null || value === undefined) return null;
  if (!value || characterLength(value) > GOAL_CURSOR_MAX_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) invalidCursor();
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (!validListCursorBinding(parsed, binding) || !validListCursorPosition(parsed)
      || cursorJson(parsed.a as string, parsed.g as string, binding) !== decoded) invalidCursor();
    return { createdAt: parsed.a as string, goalId: parsed.g as string };
  } catch (error) {
    if (error instanceof GoalError) throw error;
    return invalidCursor();
  }
}

function validListCursorBinding(
  parsed: Record<string, unknown>,
  binding: GoalListCursorBinding
): boolean {
  return Object.keys(parsed).join(',') === 'v,t,o,r,st,q,a,g'
    && parsed.v === 1 && parsed.t === 'goal-list' && parsed.o === binding.ownerUserId
    && parsed.r === (binding.repository ?? null) && parsed.st === (binding.state ?? null)
    && parsed.q === (binding.search ?? null);
}

function validListCursorPosition(parsed: Record<string, unknown>): boolean {
  return canonicalInstant(parsed.a) && typeof parsed.g === 'string' && Boolean(parsed.g)
    && characterLength(parsed.g) <= GOAL_IDENTIFIER_MAX_LENGTH;
}

function invalidCursor(): never {
  throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Goal cursor is invalid', 400);
}
