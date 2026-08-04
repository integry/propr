import { createHash, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { normalizeSplitInstruction } from './command.js';

export const ACTIVE_SPLIT_OPERATION_STATUSES = ['queued', 'running'] as const;
export const TERMINAL_SPLIT_OPERATION_STATUSES = ['completed', 'failed'] as const;
export const SPLIT_OPERATION_STATUSES = [
  ...ACTIVE_SPLIT_OPERATION_STATUSES,
  ...TERMINAL_SPLIT_OPERATION_STATUSES,
] as const;
export const DEFAULT_SPLIT_OPERATION_LEASE_MS = 15 * 60 * 1000;
export const STALE_SPLIT_OPERATION_ERROR = 'Split operation lease expired before completion';

export type SplitOperationStatus = (typeof SPLIT_OPERATION_STATUSES)[number];

export interface PrSplitOperation {
  id: string;
  repository: string;
  source_pr_number: number;
  base_ref: string;
  base_sha: string;
  head_sha: string;
  requester: string;
  original_comment_id: number;
  instruction: string;
  event_key: string;
  dedupe_key: string;
  status: SplitOperationStatus;
  error_message: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePrSplitOperationInput {
  repository: string;
  sourcePrNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  requester: string;
  originalCommentId: number;
  instruction: string;
}

export interface SplitEventKeyInput {
  repository: string;
  originalCommentId: number;
}

export interface SplitDedupeKeyInput {
  repository: string;
  sourcePrNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  instruction: string;
}

export type CreatePrSplitOperationResult =
  | { outcome: 'created'; operation: PrSplitOperation }
  | {
      outcome: 'duplicate';
      duplicateKind: 'event' | 'semantic';
      operation: PrSplitOperation;
    }
  | { outcome: 'active'; operation: PrSplitOperation };

export interface UpdatePrSplitOperationStatusOptions {
  errorMessage?: string | null;
  leaseDurationMs?: number;
  now?: Date;
}

function normalizeRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

function normalizeRef(ref: string): string {
  return ref.trim();
}

function hashCanonicalInput(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Stable identity for one GitHub issue-comment event across webhook retries. */
export function buildSplitOperationEventKey(input: SplitEventKeyInput): string {
  return hashCanonicalInput([
    normalizeRepository(input.repository),
    input.originalCommentId,
  ]);
}

/** Stable semantic key for equivalent split inputs, independent of event identity. */
export function buildSplitOperationDedupeKey(input: SplitDedupeKeyInput): string {
  return hashCanonicalInput([
    normalizeRepository(input.repository),
    input.sourcePrNumber,
    normalizeRef(input.baseRef),
    normalizeSha(input.baseSha),
    normalizeSha(input.headSha),
    normalizeSplitInstruction(input.instruction),
  ]);
}

export function isActiveSplitOperationStatus(status: SplitOperationStatus): boolean {
  return ACTIVE_SPLIT_OPERATION_STATUSES.includes(
    status as (typeof ACTIVE_SPLIT_OPERATION_STATUSES)[number],
  );
}

export function isTerminalSplitOperationStatus(status: SplitOperationStatus): boolean {
  return TERMINAL_SPLIT_OPERATION_STATUSES.includes(
    status as (typeof TERMINAL_SPLIT_OPERATION_STATUSES)[number],
  );
}

async function resolveDb(client?: Knex): Promise<Knex> {
  if (client) return client;
  return (await import('../../db/connection.js')).db;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

function timestamp(date: Date): string {
  return date.toISOString();
}

function leaseExpiry(now: Date, leaseDurationMs = DEFAULT_SPLIT_OPERATION_LEASE_MS): string {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError('Split operation lease duration must be a positive number');
  }
  return timestamp(new Date(now.getTime() + leaseDurationMs));
}

async function findByEventKey(client: Knex, eventKey: string): Promise<PrSplitOperation | undefined> {
  return client<PrSplitOperation>('pr_split_operations')
    .where({ event_key: eventKey })
    .first();
}

async function findSemanticDuplicate(
  client: Knex,
  dedupeKey: string,
): Promise<PrSplitOperation | undefined> {
  return client<PrSplitOperation>('pr_split_operations')
    .where({ dedupe_key: dedupeKey })
    .whereNot({ status: 'failed' })
    .orderBy('created_at', 'desc')
    .first();
}

/** Find the queued/running operation that currently owns a source PR lock. */
export async function getActivePrSplitOperation(
  repository: string,
  sourcePrNumber: number,
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  const client = await resolveDb(dbClient);
  const operation = await client<PrSplitOperation>('pr_split_operations')
    .whereRaw('repository = ? COLLATE NOCASE', [repository.trim()])
    .andWhere({ source_pr_number: sourcePrNumber })
    .whereIn('status', ACTIVE_SPLIT_OPERATION_STATUSES)
    .first();

  return operation ?? null;
}

/**
 * Fail active operations whose worker lease has elapsed. The conditional update
 * is safe to race with a heartbeat: only a row still expired at update time is
 * failed, which releases the partial-index PR lock.
 */
export async function recoverStalePrSplitOperations(
  repository: string,
  sourcePrNumber: number,
  dbClient?: Knex,
  now = new Date(),
): Promise<number> {
  const client = await resolveDb(dbClient);
  const currentTimestamp = timestamp(now);

  return client<PrSplitOperation>('pr_split_operations')
    .whereRaw('repository = ? COLLATE NOCASE', [repository.trim()])
    .andWhere({ source_pr_number: sourcePrNumber })
    .whereIn('status', ACTIVE_SPLIT_OPERATION_STATUSES)
    .andWhere((builder) => {
      builder.whereNull('lease_expires_at').orWhere('lease_expires_at', '<=', currentTimestamp);
    })
    .update({
      status: 'failed',
      error_message: STALE_SPLIT_OPERATION_ERROR,
      lease_expires_at: null,
      finished_at: currentTimestamp,
      updated_at: currentTimestamp,
    });
}

/**
 * Atomically create a queued operation, dedupe it, or return the active lock
 * owner. Event and semantic conflicts are resolved separately. Failed semantic
 * requests may be retried by a later comment, while a redelivery of the same
 * comment always resolves to its original operation.
 */
export async function createOrGetPrSplitOperation(
  input: CreatePrSplitOperationInput,
  dbClient?: Knex,
): Promise<CreatePrSplitOperationResult> {
  const client = await resolveDb(dbClient);
  const now = new Date();
  const normalizedInstruction = normalizeSplitInstruction(input.instruction);
  const repository = input.repository.trim();
  const eventKey = buildSplitOperationEventKey({
    repository,
    originalCommentId: input.originalCommentId,
  });
  const dedupeKey = buildSplitOperationDedupeKey({
    repository,
    sourcePrNumber: input.sourcePrNumber,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    headSha: input.headSha,
    instruction: normalizedInstruction,
  });

  await recoverStalePrSplitOperations(repository, input.sourcePrNumber, client, now);

  const currentTimestamp = timestamp(now);
  const record = {
    id: randomUUID(),
    repository,
    source_pr_number: input.sourcePrNumber,
    base_ref: normalizeRef(input.baseRef),
    base_sha: normalizeSha(input.baseSha),
    head_sha: normalizeSha(input.headSha),
    requester: input.requester,
    original_comment_id: input.originalCommentId,
    instruction: normalizedInstruction,
    event_key: eventKey,
    dedupe_key: dedupeKey,
    status: 'queued' as const,
    error_message: null,
    started_at: null,
    heartbeat_at: currentTimestamp,
    lease_expires_at: leaseExpiry(now),
    finished_at: null,
    created_at: currentTimestamp,
    updated_at: currentTimestamp,
  };

  // An active conflict may finish between the failed insert and lookup. Retry
  // once in that narrow case; event and semantic conflicts remain stable.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client('pr_split_operations').insert(record);
      const operation = await findByEventKey(client, eventKey);
      if (!operation) throw new Error('Created PR split operation could not be read back');
      return { outcome: 'created', operation };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      const eventDuplicate = await findByEventKey(client, eventKey);
      if (eventDuplicate) {
        return { outcome: 'duplicate', duplicateKind: 'event', operation: eventDuplicate };
      }

      const semanticDuplicate = await findSemanticDuplicate(client, dedupeKey);
      if (semanticDuplicate) {
        return { outcome: 'duplicate', duplicateKind: 'semantic', operation: semanticDuplicate };
      }

      const active = await getActivePrSplitOperation(repository, input.sourcePrNumber, client);
      if (active) return { outcome: 'active', operation: active };

      if (attempt === 1) throw error;
    }
  }

  throw new Error('Unable to create PR split operation');
}

export async function getPrSplitOperation(
  operationId: string,
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  const client = await resolveDb(dbClient);
  const operation = await client<PrSplitOperation>('pr_split_operations')
    .where({ id: operationId })
    .first();
  return operation ?? null;
}

const ALLOWED_TRANSITION_SOURCES: Partial<Record<SplitOperationStatus, readonly SplitOperationStatus[]>> = {
  running: ['queued'],
  completed: ['running'],
  failed: ['queued', 'running'],
};

/**
 * Apply one permitted lifecycle transition using a compare-and-swap update.
 * A null result means the operation did not exist or another worker already
 * changed its state, so only one worker can claim queued work.
 */
export async function updatePrSplitOperationStatus(
  operationId: string,
  status: SplitOperationStatus,
  options: UpdatePrSplitOperationStatusOptions = {},
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  const allowedSources = ALLOWED_TRANSITION_SOURCES[status];
  if (!allowedSources) return null;

  const client = await resolveDb(dbClient);
  const now = options.now ?? new Date();
  const currentTimestamp = timestamp(now);
  const updates: Record<string, unknown> = {
    status,
    updated_at: currentTimestamp,
  };

  if (status === 'running') {
    updates.started_at = currentTimestamp;
    updates.heartbeat_at = currentTimestamp;
    updates.lease_expires_at = leaseExpiry(now, options.leaseDurationMs);
    updates.finished_at = null;
    updates.error_message = null;
  } else {
    updates.finished_at = currentTimestamp;
    updates.lease_expires_at = null;
    updates.error_message = status === 'completed'
      ? null
      : options.errorMessage?.trim() || 'Split operation failed';
  }

  const updated = await client<PrSplitOperation>('pr_split_operations')
    .where({ id: operationId })
    .whereIn('status', allowedSources)
    .update(updates);
  if (updated === 0) return null;

  return getPrSplitOperation(operationId, client);
}

/** Extend a running operation's lease without changing its lifecycle state. */
export async function heartbeatPrSplitOperation(
  operationId: string,
  options: UpdatePrSplitOperationStatusOptions = {},
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  const client = await resolveDb(dbClient);
  const now = options.now ?? new Date();
  const currentTimestamp = timestamp(now);
  const updated = await client<PrSplitOperation>('pr_split_operations')
    .where({ id: operationId, status: 'running' })
    .andWhere('lease_expires_at', '>', currentTimestamp)
    .update({
      heartbeat_at: currentTimestamp,
      lease_expires_at: leaseExpiry(now, options.leaseDurationMs),
      updated_at: currentTimestamp,
    });
  if (updated === 0) return null;

  return getPrSplitOperation(operationId, client);
}
