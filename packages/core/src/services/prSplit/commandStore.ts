import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { normalizeSplitInstruction } from './command.js';
import {
  buildSplitOperationDedupeKey,
  buildSplitOperationEventKey,
  normalizeGitHubId,
  normalizePositiveInteger,
  type SplitEventKeyInput,
} from './keys.js';
import {
  createPrSplitOperationDecision,
  getPrSplitOperation,
  isPrSplitUniqueConstraintError,
  resolvePrSplitDb,
  type CreatePrSplitOperationInput,
  type PrSplitOperation,
  type PrSplitOperationDecision,
} from './operationStore.js';

export const TERMINAL_PR_SPLIT_COMMAND_OUTCOMES = [
  'disabled',
  'unauthorized',
  'closed',
  'invalid',
  'rate_limited',
  'queued',
  'duplicate',
  'active',
] as const;

export type PrSplitCommandOutcome = (typeof TERMINAL_PR_SPLIT_COMMAND_OUTCOMES)[number];
export type PrSplitResponseState = 'pending' | 'claimed' | 'posted' | 'suppressed';

export const DEFAULT_PR_SPLIT_RESPONSE_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_PR_SPLIT_COMMAND_RATE_LIMIT = 5;
export const DEFAULT_PR_SPLIT_COMMAND_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export interface PrSplitResponseClaim {
  token: string;
  needsReconciliation: boolean;
}

export interface PrSplitCommandRateLimitOptions {
  now?: Date;
  maxCommands?: number;
  windowMs?: number;
}

export interface PrSplitCommandReceipt {
  event_key: string;
  repository_id: number;
  repository: string;
  source_pr_number: number;
  requester_id: number;
  requester: string;
  original_comment_id: number;
  instruction: string;
  outcome: PrSplitCommandOutcome | 'processing';
  duplicate_kind: 'event' | 'semantic' | null;
  operation_id: string | null;
  response_state: PrSplitResponseState;
  response_claim_token: string | null;
  response_claimed_at: string | null;
  response_comment_id: number | null;
  response_posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrSplitCommandInput {
  repositoryId: number;
  repository: string;
  sourcePrNumber: number;
  requesterId: number;
  requester: string;
  originalCommentId: number;
  instruction: string;
}

export interface RecordPrSplitCommandOutcomeInput extends PrSplitCommandInput {
  outcome: Extract<
    PrSplitCommandOutcome,
    'disabled' | 'unauthorized' | 'closed' | 'invalid' | 'rate_limited'
  >;
}

export interface PrSplitCommandRecord {
  receipt: PrSplitCommandReceipt;
  operation: PrSplitOperation | null;
  replayed: boolean;
}

let localCommandWriteTail = Promise.resolve();

async function withLocalCommandWriteLock<T>(action: () => Promise<T>): Promise<T> {
  const previous = localCommandWriteTail;
  let release = (): void => undefined;
  localCommandWriteTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

function timestamp(date: Date): string {
  return date.toISOString();
}

function isSqliteBusyError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('SQLITE_BUSY');
}

async function withSqliteBusyRetry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt === 4) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error('SQLite write retry limit exhausted');
}

async function withCommandWrite<T>(action: () => Promise<T>): Promise<T> {
  return withLocalCommandWriteLock(() => withSqliteBusyRetry(action));
}

function receiptInsert(input: PrSplitCommandInput, outcome: string, now: Date) {
  const repositoryId = normalizeGitHubId(input.repositoryId, 'repositoryId');
  const requesterId = normalizeGitHubId(input.requesterId, 'requesterId');
  const sourcePrNumber = normalizePositiveInteger(input.sourcePrNumber, 'sourcePrNumber');
  const eventKey = buildSplitOperationEventKey({
    repositoryId,
    originalCommentId: input.originalCommentId,
  });
  const currentTimestamp = timestamp(now);

  return {
    event_key: eventKey,
    repository_id: repositoryId,
    repository: input.repository.trim(),
    source_pr_number: sourcePrNumber,
    requester_id: requesterId,
    requester: input.requester,
    original_comment_id: normalizeGitHubId(input.originalCommentId, 'originalCommentId'),
    instruction: normalizeSplitInstruction(input.instruction),
    outcome,
    duplicate_kind: null,
    operation_id: null,
    response_state: outcome === 'rate_limited' ? 'suppressed' : 'pending',
    response_claim_token: null,
    response_claimed_at: null,
    response_comment_id: null,
    response_posted_at: null,
    created_at: currentTimestamp,
    updated_at: currentTimestamp,
  };
}

async function findReceipt(
  client: Knex,
  eventKey: string,
): Promise<PrSplitCommandReceipt | undefined> {
  return client<PrSplitCommandReceipt>('pr_split_command_receipts')
    .where({ event_key: eventKey })
    .first();
}

async function hydrateRecord(
  client: Knex,
  receipt: PrSplitCommandReceipt,
  replayed: boolean,
): Promise<PrSplitCommandRecord> {
  const operation = receipt.operation_id
    ? await getPrSplitOperation(receipt.operation_id, client)
    : null;
  return { receipt, operation, replayed };
}

async function findRecord(
  client: Knex,
  eventKey: string,
  replayed: boolean,
): Promise<PrSplitCommandRecord | null> {
  const receipt = await findReceipt(client, eventKey);
  return receipt ? hydrateRecord(client, receipt, replayed) : null;
}

/** Return the immutable disposition already assigned to a source comment. */
export async function getPrSplitCommandRecord(
  input: SplitEventKeyInput,
  dbClient?: Knex,
): Promise<PrSplitCommandRecord | null> {
  const client = await resolvePrSplitDb(dbClient);
  return findRecord(client, buildSplitOperationEventKey(input), true);
}

function rateLimitOptions(options: PrSplitCommandRateLimitOptions): {
  now: Date;
  maxCommands: number;
  windowMs: number;
} {
  const now = options.now ?? new Date();
  const maxCommands = options.maxCommands ?? DEFAULT_PR_SPLIT_COMMAND_RATE_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_PR_SPLIT_COMMAND_RATE_LIMIT_WINDOW_MS;
  if (!Number.isSafeInteger(maxCommands) || maxCommands <= 0) {
    throw new RangeError('PR split command rate limit must be a positive safe integer');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('PR split command rate limit window must be positive');
  }
  return { now, maxCommands, windowMs };
}

/**
 * Atomically reserve an event and its per-user rate-limit slot. Inserting the
 * processing receipt is deliberately the transaction's first database action:
 * SQLite writers are serialized before any process counts the active window.
 */
export async function reservePrSplitCommand(
  input: PrSplitCommandInput,
  dbClient?: Knex,
  options: PrSplitCommandRateLimitOptions = {},
): Promise<PrSplitCommandRecord> {
  const { now, maxCommands, windowMs } = rateLimitOptions(options);
  const client = await resolvePrSplitDb(dbClient);
  const pendingReceipt = receiptInsert(input, 'processing', now);
  const existing = await findRecord(client, pendingReceipt.event_key, true);
  if (existing) return existing;

  return withCommandWrite(async () => {
    const raced = await findRecord(client, pendingReceipt.event_key, true);
    if (raced) return raced;
    try {
      return await client.transaction(async (transaction) => {
        await transaction('pr_split_command_receipts').insert(pendingReceipt);
        const row = await transaction('pr_split_command_receipts')
          .where({
            repository_id: pendingReceipt.repository_id,
            requester_id: pendingReceipt.requester_id,
          })
          .andWhere('created_at', '>=', timestamp(new Date(now.getTime() - windowMs)))
          .count({ count: '*' })
          .first();
        if (Number(row?.count ?? 0) > maxCommands) {
          await transaction<PrSplitCommandReceipt>('pr_split_command_receipts')
            .where({ event_key: pendingReceipt.event_key, outcome: 'processing' })
            .update({ outcome: 'rate_limited', response_state: 'suppressed' });
        }
        const receipt = await findReceipt(transaction, pendingReceipt.event_key);
        if (!receipt) throw new Error('Reserved PR split command receipt could not be read back');
        return hydrateRecord(transaction, receipt, false);
      });
    } catch (error) {
      if (isPrSplitUniqueConstraintError(error)) {
        const concurrent = await findRecord(client, pendingReceipt.event_key, true);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  });
}

/** Persist a non-executable command disposition before attempting its response. */
export async function recordPrSplitCommandOutcome(
  input: RecordPrSplitCommandOutcomeInput,
  dbClient?: Knex,
): Promise<PrSplitCommandRecord> {
  const reservation = await reservePrSplitCommand(input, dbClient);
  if (reservation.receipt.outcome !== 'processing') return reservation;
  const client = await resolvePrSplitDb(dbClient);
  const eventKey = reservation.receipt.event_key;

  return withCommandWrite(async () => {
    const now = new Date();
    const updated = await client<PrSplitCommandReceipt>('pr_split_command_receipts')
      .where({ event_key: eventKey, outcome: 'processing' })
      .update({
        outcome: input.outcome,
        response_state: input.outcome === 'rate_limited' ? 'suppressed' : 'pending',
        updated_at: timestamp(now),
      });
    const receipt = await findReceipt(client, eventKey);
    if (!receipt) throw new Error('Completed PR split command receipt could not be read back');
    return hydrateRecord(client, receipt, updated === 0);
  });
}

function receiptOutcome(decision: PrSplitOperationDecision): {
  outcome: Extract<PrSplitCommandOutcome, 'queued' | 'duplicate' | 'active'>;
  duplicateKind: 'event' | 'semantic' | null;
} {
  if (decision.outcome === 'created') return { outcome: 'queued', duplicateKind: null };
  if (decision.outcome === 'active') return { outcome: 'active', duplicateKind: null };
  return { outcome: 'duplicate', duplicateKind: decision.duplicateKind };
}

/**
 * Atomically assign a terminal command disposition and create/dedupe/lock its
 * executable operation. A competing condition change can never overwrite the
 * first disposition committed for the source comment.
 */
export async function createOrGetPrSplitOperation(
  input: CreatePrSplitOperationInput,
  dbClient?: Knex,
): Promise<PrSplitCommandRecord> {
  buildSplitOperationDedupeKey(input);
  const reservation = await reservePrSplitCommand(input, dbClient);
  if (reservation.receipt.outcome !== 'processing') return reservation;
  const client = await resolvePrSplitDb(dbClient);
  const eventKey = reservation.receipt.event_key;

  return withCommandWrite(() => client.transaction(async (transaction) => {
    const now = new Date();
    const claimed = await transaction<PrSplitCommandReceipt>('pr_split_command_receipts')
      .where({ event_key: eventKey, outcome: 'processing' })
      .update({ updated_at: timestamp(now) });
    if (claimed === 0) {
      const completed = await findRecord(transaction, eventKey, true);
      if (!completed) throw new Error('Reserved PR split command receipt disappeared');
      return completed;
    }

    const decision = await createPrSplitOperationDecision(input, transaction, now);
    const terminal = receiptOutcome(decision);
    await transaction<PrSplitCommandReceipt>('pr_split_command_receipts')
      .where({ event_key: eventKey, outcome: 'processing' })
      .update({
        outcome: terminal.outcome,
        duplicate_kind: terminal.duplicateKind,
        operation_id: decision.operation.id,
        updated_at: timestamp(now),
      });
    const receipt = await findReceipt(transaction, eventKey);
    if (!receipt) throw new Error('Created PR split command receipt could not be read back');
    return { receipt, operation: decision.operation, replayed: false };
  }));
}

/** Claim a response attempt, reclaiming abandoned attempts after their lease. */
export async function claimPrSplitCommandResponse(
  eventKey: string,
  dbClient?: Knex,
  now = new Date(),
  leaseDurationMs = DEFAULT_PR_SPLIT_RESPONSE_CLAIM_LEASE_MS,
): Promise<PrSplitResponseClaim | null> {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError('PR split response claim lease must be positive');
  }
  const client = await resolvePrSplitDb(dbClient);
  const claimToken = randomUUID();
  const currentTimestamp = timestamp(now);
  const claimedPending = await client<PrSplitCommandReceipt>('pr_split_command_receipts')
    .where({ event_key: eventKey, response_state: 'pending' })
    .whereNot({ outcome: 'processing' })
    .update({
      response_state: 'claimed',
      response_claim_token: claimToken,
      response_claimed_at: currentTimestamp,
      updated_at: currentTimestamp,
    });
  if (claimedPending === 1) {
    return { token: claimToken, needsReconciliation: false };
  }

  const staleBefore = timestamp(new Date(now.getTime() - leaseDurationMs));
  const reclaimed = await client<PrSplitCommandReceipt>('pr_split_command_receipts')
    .where({ event_key: eventKey, response_state: 'claimed' })
    .andWhere((builder) => {
      builder.whereNull('response_claimed_at').orWhere('response_claimed_at', '<=', staleBefore);
    })
    .update({
      response_claim_token: claimToken,
      response_claimed_at: currentTimestamp,
      updated_at: currentTimestamp,
    });
  return reclaimed === 1 ? { token: claimToken, needsReconciliation: true } : null;
}

/** Release a claim only when no GitHub response could have been created. */
export async function releasePrSplitCommandResponseClaim(
  eventKey: string,
  claimToken: string,
  dbClient?: Knex,
): Promise<boolean> {
  const client = await resolvePrSplitDb(dbClient);
  const currentTimestamp = timestamp(new Date());
  const released = await client<PrSplitCommandReceipt>('pr_split_command_receipts')
    .where({
      event_key: eventKey,
      response_state: 'claimed',
      response_claim_token: claimToken,
    })
    .update({
      response_state: 'pending',
      response_claim_token: null,
      response_claimed_at: null,
      updated_at: currentTimestamp,
    });
  return released === 1;
}

/** Mark the claimed response as posted without allowing another claimant. */
export async function markPrSplitCommandResponsePosted(
  eventKey: string,
  claimToken: string,
  responseCommentId: number | null,
  dbClient?: Knex,
): Promise<boolean> {
  const client = await resolvePrSplitDb(dbClient);
  const currentTimestamp = timestamp(new Date());
  const updated = await client<PrSplitCommandReceipt>('pr_split_command_receipts')
    .where({
      event_key: eventKey,
      response_state: 'claimed',
      response_claim_token: claimToken,
    })
    .update({
      response_state: 'posted',
      response_claim_token: null,
      response_comment_id: responseCommentId,
      response_posted_at: currentTimestamp,
      updated_at: currentTimestamp,
    });
  return updated === 1;
}
