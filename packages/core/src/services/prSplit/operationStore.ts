import { createHash, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { normalizeSplitInstruction } from './command.js';

export const ACTIVE_SPLIT_OPERATION_STATUSES = ['queued', 'running'] as const;
export const TERMINAL_SPLIT_OPERATION_STATUSES = ['completed', 'failed'] as const;
export const SPLIT_OPERATION_STATUSES = [
  ...ACTIVE_SPLIT_OPERATION_STATUSES,
  ...TERMINAL_SPLIT_OPERATION_STATUSES,
] as const;

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
  dedupe_key: string;
  status: SplitOperationStatus;
  error_message: string | null;
  started_at: string | null;
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

export interface SplitDedupeKeyInput {
  repository: string;
  sourcePrNumber: number;
  headSha: string;
  instruction: string;
}

export type CreatePrSplitOperationResult =
  | { outcome: 'created'; operation: PrSplitOperation }
  | { outcome: 'duplicate'; operation: PrSplitOperation }
  | { outcome: 'active'; operation: PrSplitOperation };

export interface UpdatePrSplitOperationStatusOptions {
  errorMessage?: string | null;
}

function normalizeRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

/** Stable key for identical command requests on the same source head. */
export function buildSplitOperationDedupeKey(input: SplitDedupeKeyInput): string {
  const canonicalInput = JSON.stringify([
    normalizeRepository(input.repository),
    input.sourcePrNumber,
    normalizeSha(input.headSha),
    normalizeSplitInstruction(input.instruction),
  ]);

  return createHash('sha256').update(canonicalInput).digest('hex');
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
  if (typeof error !== 'object' || error === null) return false;

  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return code.startsWith('SQLITE_CONSTRAINT') || /unique constraint/i.test(message);
}

async function findByDedupeKey(client: Knex, dedupeKey: string): Promise<PrSplitOperation | undefined> {
  return client<PrSplitOperation>('pr_split_operations')
    .where({ dedupe_key: dedupeKey })
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
 * Atomically create a queued operation, dedupe it, or return the active lock
 * owner. Uniqueness is enforced by the migration, so concurrent processes use
 * the database as the arbiter rather than relying on an in-memory check.
 */
export async function createOrGetPrSplitOperation(
  input: CreatePrSplitOperationInput,
  dbClient?: Knex,
): Promise<CreatePrSplitOperationResult> {
  const client = await resolveDb(dbClient);
  const normalizedInstruction = normalizeSplitInstruction(input.instruction);
  const repository = input.repository.trim();
  const dedupeKey = buildSplitOperationDedupeKey({
    repository,
    sourcePrNumber: input.sourcePrNumber,
    headSha: input.headSha,
    instruction: normalizedInstruction,
  });

  const record = {
    id: randomUUID(),
    repository,
    source_pr_number: input.sourcePrNumber,
    base_ref: input.baseRef,
    base_sha: normalizeSha(input.baseSha),
    head_sha: normalizeSha(input.headSha),
    requester: input.requester,
    original_comment_id: input.originalCommentId,
    instruction: normalizedInstruction,
    dedupe_key: dedupeKey,
    status: 'queued' as const,
    created_at: client.fn.now(),
    updated_at: client.fn.now(),
  };

  // A conflicting active row can finish between the failed insert and lookup.
  // Retry once in that narrow case; dedupe conflicts remain stable and return.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client('pr_split_operations').insert(record);
      const operation = await findByDedupeKey(client, dedupeKey);
      if (!operation) throw new Error('Created PR split operation could not be read back');
      return { outcome: 'created', operation };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      const duplicate = await findByDedupeKey(client, dedupeKey);
      if (duplicate) return { outcome: 'duplicate', operation: duplicate };

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

/**
 * Update worker-visible state. Moving to a terminal status releases the
 * migration's partial unique-index lock immediately.
 */
export async function updatePrSplitOperationStatus(
  operationId: string,
  status: SplitOperationStatus,
  options: UpdatePrSplitOperationStatusOptions = {},
  dbClient?: Knex,
): Promise<PrSplitOperation | null> {
  const client = await resolveDb(dbClient);
  const now = client.fn.now();
  const updates: Record<string, unknown> = {
    status,
    updated_at: now,
  };

  if (status === 'running') updates.started_at = now;
  if (isTerminalSplitOperationStatus(status)) updates.finished_at = now;
  if (options.errorMessage !== undefined) updates.error_message = options.errorMessage;

  const updated = await client<PrSplitOperation>('pr_split_operations')
    .where({ id: operationId })
    .update(updates);
  if (updated === 0) return null;

  return getPrSplitOperation(operationId, client);
}
