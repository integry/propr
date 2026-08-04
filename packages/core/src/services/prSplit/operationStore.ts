import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { normalizeSplitInstruction } from './command.js';
import {
  buildSplitOperationDedupeKey,
  buildSplitOperationEventKey,
  normalizeGitHubId,
  normalizeRef,
  normalizeSha,
} from './keys.js';

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
  repository_id: number;
  repository: string;
  source_pr_number: number;
  base_ref: string;
  base_sha: string;
  head_sha: string;
  requester_id: number;
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
  lease_token: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePrSplitOperationInput {
  repositoryId: number;
  repository: string;
  sourcePrNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  requesterId: number;
  requester: string;
  originalCommentId: number;
  instruction: string;
}

export type PrSplitOperationDecision =
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
  leaseToken?: string;
  now?: Date;
}

export interface HeartbeatPrSplitOperationOptions {
  leaseToken: string;
  leaseDurationMs?: number;
  now?: Date;
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

export async function resolvePrSplitDb(client?: Knex): Promise<Knex> {
  if (client) return client;
  return (await import('../../db/connection.js')).db;
}

export function isPrSplitUniqueConstraintError(error: unknown): boolean {
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
  repositoryId: number,
  sourcePrNumber: number,
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  const client = await resolvePrSplitDb(dbClient);
  const operation = await client<PrSplitOperation>('pr_split_operations')
    .where({
      repository_id: normalizeGitHubId(repositoryId, 'repositoryId'),
      source_pr_number: sourcePrNumber,
    })
    .whereIn('status', ACTIVE_SPLIT_OPERATION_STATUSES)
    .first();

  return operation ?? null;
}

/** Fail active operations whose worker lease has elapsed and release their PR lock. */
export async function recoverStalePrSplitOperations(
  repositoryId: number,
  sourcePrNumber: number,
  dbClient?: Knex,
  now = new Date(),
): Promise<number> {
  const client = await resolvePrSplitDb(dbClient);
  const currentTimestamp = timestamp(now);

  return client<PrSplitOperation>('pr_split_operations')
    .where({
      repository_id: normalizeGitHubId(repositoryId, 'repositoryId'),
      source_pr_number: sourcePrNumber,
    })
    .whereIn('status', ACTIVE_SPLIT_OPERATION_STATUSES)
    .andWhere((builder) => {
      builder.whereNull('lease_expires_at').orWhere('lease_expires_at', '<=', currentTimestamp);
    })
    .update({
      status: 'failed',
      error_message: STALE_SPLIT_OPERATION_ERROR,
      lease_expires_at: null,
      lease_token: null,
      finished_at: currentTimestamp,
      updated_at: currentTimestamp,
    });
}

/** Resolve the executable operation decision inside the caller's transaction. */
export async function createPrSplitOperationDecision(
  input: CreatePrSplitOperationInput,
  dbClient: Knex,
  now = new Date(),
): Promise<PrSplitOperationDecision> {
  const normalizedInstruction = normalizeSplitInstruction(input.instruction);
  const repositoryId = normalizeGitHubId(input.repositoryId, 'repositoryId');
  const requesterId = normalizeGitHubId(input.requesterId, 'requesterId');
  const eventKey = buildSplitOperationEventKey({
    repositoryId,
    originalCommentId: input.originalCommentId,
  });
  const dedupeKey = buildSplitOperationDedupeKey({
    repositoryId,
    sourcePrNumber: input.sourcePrNumber,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    headSha: input.headSha,
    instruction: normalizedInstruction,
  });

  await recoverStalePrSplitOperations(repositoryId, input.sourcePrNumber, dbClient, now);

  const currentTimestamp = timestamp(now);
  const record = {
    id: randomUUID(),
    repository_id: repositoryId,
    repository: input.repository.trim(),
    source_pr_number: input.sourcePrNumber,
    base_ref: normalizeRef(input.baseRef),
    base_sha: normalizeSha(input.baseSha),
    head_sha: normalizeSha(input.headSha),
    requester_id: requesterId,
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
    lease_token: null,
    finished_at: null,
    created_at: currentTimestamp,
    updated_at: currentTimestamp,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await dbClient('pr_split_operations').insert(record);
      const operation = await findByEventKey(dbClient, eventKey);
      if (!operation) throw new Error('Created PR split operation could not be read back');
      return { outcome: 'created', operation };
    } catch (error) {
      if (!isPrSplitUniqueConstraintError(error)) throw error;

      const eventDuplicate = await findByEventKey(dbClient, eventKey);
      if (eventDuplicate) {
        return { outcome: 'duplicate', duplicateKind: 'event', operation: eventDuplicate };
      }

      const semanticDuplicate = await findSemanticDuplicate(dbClient, dedupeKey);
      if (semanticDuplicate) {
        return { outcome: 'duplicate', duplicateKind: 'semantic', operation: semanticDuplicate };
      }

      const active = await getActivePrSplitOperation(
        repositoryId,
        input.sourcePrNumber,
        dbClient,
      );
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
  const client = await resolvePrSplitDb(dbClient);
  const operation = await client<PrSplitOperation>('pr_split_operations')
    .where({ id: operationId })
    .first();
  return operation ?? null;
}

/**
 * Apply a fenced lifecycle transition. Claims require a live queued lease;
 * running workers must present their claim token and still own a live lease.
 */
export async function updatePrSplitOperationStatus(
  operationId: string,
  status: SplitOperationStatus,
  options: UpdatePrSplitOperationStatusOptions = {},
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  if (status === 'queued') return null;

  const client = await resolvePrSplitDb(dbClient);
  const now = options.now ?? new Date();
  const currentTimestamp = timestamp(now);
  const updates: Record<string, unknown> = { status, updated_at: currentTimestamp };
  const query = client<PrSplitOperation>('pr_split_operations').where({ id: operationId });

  if (status === 'running') {
    query.andWhere({ status: 'queued' });
    updates.started_at = currentTimestamp;
    updates.heartbeat_at = currentTimestamp;
    updates.lease_expires_at = leaseExpiry(now, options.leaseDurationMs);
    updates.lease_token = randomUUID();
    updates.finished_at = null;
    updates.error_message = null;
  } else if (options.leaseToken) {
    query.andWhere({ status: 'running', lease_token: options.leaseToken });
    updates.finished_at = currentTimestamp;
    updates.lease_expires_at = null;
    updates.lease_token = null;
    updates.error_message = status === 'completed'
      ? null
      : options.errorMessage?.trim() || 'Split operation failed';
  } else if (status === 'failed') {
    query.andWhere({ status: 'queued' });
    updates.finished_at = currentTimestamp;
    updates.lease_expires_at = null;
    updates.lease_token = null;
    updates.error_message = options.errorMessage?.trim() || 'Split operation failed';
  } else {
    return null;
  }

  const updated = await query
    .andWhere('lease_expires_at', '>', currentTimestamp)
    .update(updates);
  if (updated === 0) return null;
  return getPrSplitOperation(operationId, client);
}

/** Extend a running operation's lease while proving ownership with its claim token. */
export async function heartbeatPrSplitOperation(
  operationId: string,
  options: HeartbeatPrSplitOperationOptions,
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  const client = await resolvePrSplitDb(dbClient);
  const now = options.now ?? new Date();
  const currentTimestamp = timestamp(now);
  const updated = await client<PrSplitOperation>('pr_split_operations')
    .where({ id: operationId, status: 'running', lease_token: options.leaseToken })
    .andWhere('lease_expires_at', '>', currentTimestamp)
    .update({
      heartbeat_at: currentTimestamp,
      lease_expires_at: leaseExpiry(now, options.leaseDurationMs),
      updated_at: currentTimestamp,
    });
  if (updated === 0) return null;
  return getPrSplitOperation(operationId, client);
}

/**
 * Fence external GitHub side effects. A future worker must call this immediately
 * before each side effect and stop if the token no longer owns a live lease.
 */
export async function assertPrSplitOperationLease(
  operationId: string,
  leaseToken: string,
  dbClient?: Knex,
  now = new Date(),
): Promise<PrSplitOperation | null> {
  const client = await resolvePrSplitDb(dbClient);
  const operation = await client<PrSplitOperation>('pr_split_operations')
    .where({ id: operationId, status: 'running', lease_token: leaseToken })
    .andWhere('lease_expires_at', '>', timestamp(now))
    .first();
  return operation ?? null;
}
