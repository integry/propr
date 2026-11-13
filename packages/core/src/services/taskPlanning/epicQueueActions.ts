import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import {
  clearedBlock, getEpicExecutionQueue, ownedIssue, startEpicQueueHead, summarizeEpicQueue, writeQueueIssue,
  type EpicExecutionQueue, type EpicQueueBlockedKind, type EpicQueueDependencies, type EpicQueueIssue, type EpicQueueIssueState,
} from './epicExecutionQueue.js';
import { latestBlockedEvent } from './epicQueueBlockedEvents.js';

/**
 * A person moving an epic execution past an issue. Both actions are guarded like every
 * other queue write: they name the execution they act on and are refused for a stale one,
 * they recheck the issue's observed state in the same statement as the write, and they are
 * idempotent (repeating one that already took effect changes nothing).
 *
 * - Skip marks a pending or blocked issue skipped: the queue treats it as finished for
 *   scheduling. A chain moves on to the next issue. In a graph, its dependents keep waiting on
 *   the skipped prerequisite unless `satisfiesDependents` says the dependency counts as met.
 *   Skipping never closes or edits the GitHub issue.
 * - Retry clears a blocked issue's blocker and dispatches it again under the normal guards.
 */
export type EpicQueueActionErrorCode = 'NOT_FOUND' | 'STALE_EXECUTION' | 'IN_FLIGHT' | 'ALREADY_DONE' | 'STATE_CHANGED'
  | 'NOT_BLOCKED' | 'NOT_RETRYABLE';

export class EpicQueueActionError extends Error {
  constructor(readonly code: EpicQueueActionErrorCode, message: string, readonly status = code === 'NOT_FOUND' ? 404 : 409) {
    super(message);
    this.name = 'EpicQueueActionError';
  }
}

export interface EpicQueueActionInput {
  draftId: string;
  /** The execution the caller read; a newer or finished execution refuses the action. */
  executionId: string;
  issueNumber: number;
  /** The issue state the caller read, when it wants the action refused after a change. */
  expectedState?: EpicQueueIssueState;
}

export interface EpicQueueActionDependencies extends EpicQueueDependencies {
  /** Reopens a closed GitHub issue before a retry; injected in tests. */
  reopenIssue?: (repository: string, issueNumber: number) => Promise<void>;
}

export type EpicQueueActionOutcome = 'skipped' | 'already_skipped' | 'retried' | 'already_retried';

export interface EpicQueueActionResult {
  outcome: EpicQueueActionOutcome;
  executionId: string;
  issueNumber: number;
  queue: ReturnType<typeof summarizeEpicQueue>;
}

const RUNNING_PLAN_STATUSES_EXCLUDED = ['pending', 'merged', 'closed'];
/**
 * How long a retry's reservation holds the issue while the retry reopens it on GitHub. Competing skips
 * and retries are refused while it holds; one left by a process that stopped lapses after this.
 */
export const RETRY_RESERVATION_MS = 5 * 60 * 1000;

/** Rows no retry currently holds: never reserved, released, or reserved by a retry that stopped. */
function unreserved(query: Knex.QueryBuilder, timestamp: number): Knex.QueryBuilder {
  return query.where(free => free.whereNull('retry_reserved_at').orWhere('retry_reserved_at', '<=', timestamp - RETRY_RESERVATION_MS));
}

async function refuseReserved(database: Knex, queue: EpicExecutionQueue, item: EpicQueueIssue, timestamp: number): Promise<void> {
  if (!await unreserved(ownedIssue(database, queue, item), timestamp).first('issue_number')
    && await ownedIssue(database, queue, item).first('issue_number')) {
    throw new EpicQueueActionError('IN_FLIGHT', `Issue #${item.issueNumber} is being retried; read the execution queue again.`);
  }
}

/** The issue already merged: its queue row may not have settled yet, but it is done. */
function mergedPlanIssue(database: Knex, draftId: string, issueNumber: number): Knex.QueryBuilder {
  return database('plan_issues').select('id').where({ draft_id: draftId, issue_number: issueNumber, status: 'merged' });
}

async function locate(database: Knex, input: EpicQueueActionInput): Promise<{ queue: EpicExecutionQueue; item: EpicQueueIssue }> {
  const queue = await getEpicExecutionQueue(input.draftId, { database });
  if (!queue || queue.executionId !== input.executionId) {
    throw new EpicQueueActionError('STALE_EXECUTION', 'This execution is no longer the plan\'s current execution. Read the execution queue again.');
  }
  if (queue.status !== 'active') throw new EpicQueueActionError('STALE_EXECUTION', `This execution is ${queue.status}.`);
  const item = queue.items.find(candidate => candidate.issueNumber === input.issueNumber);
  if (!item) throw new EpicQueueActionError('NOT_FOUND', `Issue #${input.issueNumber} is not part of this execution.`);
  if (input.expectedState && item.state !== input.expectedState) {
    throw new EpicQueueActionError('STATE_CHANGED', `Issue #${input.issueNumber} is ${item.state}, not ${input.expectedState}. Read the execution queue again.`);
  }
  return { queue, item };
}

/** Whether the issue runs without a queue claim: a person started it, so its plan status is in progress. */
async function runsWithoutClaim(database: Knex, draftId: string, issueNumber: number): Promise<boolean> {
  return Boolean(await database('plan_issues').where({ draft_id: draftId, issue_number: issueNumber })
    .whereNotIn('status', RUNNING_PLAN_STATUSES_EXCLUDED).first('id'));
}

function refuseSettledOrInFlight(item: EpicQueueIssue): never {
  if (item.state === 'done') throw new EpicQueueActionError('ALREADY_DONE', `Issue #${item.issueNumber} is already done in this execution.`);
  if (item.state === 'skipped') throw new EpicQueueActionError('NOT_BLOCKED', `Issue #${item.issueNumber} is skipped in this execution.`);
  throw new EpicQueueActionError('IN_FLIGHT', `Issue #${item.issueNumber} is in flight; wait for its run to finish or block.`);
}

async function result(database: Knex, input: EpicQueueActionInput, outcome: EpicQueueActionOutcome): Promise<EpicQueueActionResult> {
  return { outcome, executionId: input.executionId, issueNumber: input.issueNumber,
    queue: summarizeEpicQueue(await getEpicExecutionQueue(input.draftId, { database })) };
}

/** The action took effect; moving the queue on is recovered by the sweep when it fails now. */
async function drive(work: () => Promise<void>, input: EpicQueueActionInput): Promise<void> {
  try { await work(); }
  catch (error) { logger.warn?.({ draftId: input.draftId, issueNumber: input.issueNumber, error: (error as Error).message }, 'Epic queue did not move on after a queue action; recovery retries'); }
}

export async function skipEpicQueueIssue(input: EpicQueueActionInput & { satisfiesDependents?: boolean },
  deps: EpicQueueActionDependencies = {}): Promise<EpicQueueActionResult> {
  const database = deps.database ?? db;
  const { queue, item } = await locate(database, input);
  // Only a graph has dependents that a skip can leave waiting; a chain always moves on.
  const satisfies = queue.mode === 'graph' && Boolean(input.satisfiesDependents);
  const timestamp = (deps.now ?? Date.now)();
  if (item.state === 'skipped') {
    if (queue.mode !== 'graph' || item.skipSatisfiesDependents === satisfies) return result(database, input, 'already_skipped');
    // Skipping again with the other dependency option changes only that option.
    const changed = await ownedIssue(database, queue, item).where({ state: 'skipped', skip_satisfies_dependents: item.skipSatisfiesDependents })
      .update({ skip_satisfies_dependents: satisfies, updated_at: timestamp });
    if (!changed) throw new EpicQueueActionError('STATE_CHANGED', `Issue #${item.issueNumber} changed; read the execution queue again.`);
    await drive(() => startEpicQueueHead(input.draftId, deps), input);
    return result(database, input, 'skipped');
  }
  if (item.state !== 'pending' && item.state !== 'blocked') refuseSettledOrInFlight(item);
  // A merged prerequisite is done even before its queue row settles; skipping it would strand its dependents.
  if (await mergedPlanIssue(database, queue.draftId, item.issueNumber).first()) refuseSettledOrInFlight({ ...item, state: 'done' });
  if (item.state === 'pending' && await runsWithoutClaim(database, queue.draftId, item.issueNumber)) refuseSettledOrInFlight({ ...item, state: 'dispatched' });
  await refuseReserved(database, queue, item, timestamp);
  const changed = await writeQueueIssue(database, { owner: queue, item, resolution: 'skipped', timestamp }, trx => {
    const query = unreserved(ownedIssue(trx, queue, item).where({ state: item.state }), timestamp)
      .whereNotExists(mergedPlanIssue(trx, queue.draftId, item.issueNumber));
    if (item.state === 'blocked') query.where({ blocked_kind: item.blockedKind });
    // A pending issue a person started meanwhile is in flight.
    else query.whereNull('dispatched_at').whereNotExists(trx('plan_issues').select('id')
      .where({ draft_id: queue.draftId, issue_number: item.issueNumber }).whereNotIn('status', RUNNING_PLAN_STATUSES_EXCLUDED));
    return query.update({ state: 'skipped', skip_satisfies_dependents: satisfies, blocked_kind: null, blocked_reason: null,
      blocked_at: null, retry_reserved_at: null, updated_at: timestamp });
  });
  if (!changed) {
    if (await mergedPlanIssue(database, queue.draftId, item.issueNumber).first()) refuseSettledOrInFlight({ ...item, state: 'done' });
    throw new EpicQueueActionError('STATE_CHANGED', `Issue #${item.issueNumber} changed while it was being skipped; read the execution queue again.`);
  }
  await drive(() => startEpicQueueHead(input.draftId, deps), input);
  return result(database, input, 'skipped');
}

/** Blockers a retry dispatches afresh: the queue's claim is dropped so the normal dispatch claims the issue again. */
const RECLAIMED_KINDS: EpicQueueBlockedKind[] = ['dispatch_failed', 'agent_blocked', 'closed_unmerged', 'missing_from_plan'];
/** Blockers whose plan issue is left in progress (or closed) by the run; a retry puts it back to pending. */
const PLAN_RESET_KINDS: EpicQueueBlockedKind[] = ['agent_blocked', 'closed_unmerged'];

/** One retry of a blocked occurrence the caller read. */
interface RetryAttempt { database: Knex; queue: EpicExecutionQueue; item: EpicQueueIssue; kind: EpicQueueBlockedKind; timestamp: number }

/** The blocked occurrence the caller read, as it read it. */
function retryable(database: Knex, { queue, item, kind }: RetryAttempt): Knex.QueryBuilder {
  return ownedIssue(database, queue, item, { ready: true }).where({ state: 'blocked', blocked_kind: kind, blocked_reason: item.blockedReason });
}

/**
 * Reserves the issue for this retry before its GitHub side effect, so a competing skip or retry that
 * commits meanwhile cannot have the issue reopened after it. Returns the reservation, or refuses.
 */
async function reserveRetry(attempt: RetryAttempt): Promise<number> {
  const { database, queue, item, timestamp } = attempt;
  await refuseReserved(database, queue, item, timestamp);
  const reserved = await unreserved(retryable(database, attempt), timestamp).update({ retry_reserved_at: timestamp });
  if (!reserved) {
    await refuseReserved(database, queue, item, timestamp);
    throw new EpicQueueActionError('STATE_CHANGED', `Issue #${item.issueNumber} changed while it was being retried; read the execution queue again.`);
  }
  return timestamp;
}

/** Drops a reservation this retry still holds (whatever happened to the row meanwhile). */
async function releaseRetry({ database, queue, item }: RetryAttempt, reservation: number): Promise<void> {
  try { await ownedIssue(database, queue, item).where({ retry_reserved_at: reservation }).update({ retry_reserved_at: null }); }
  catch (error) { logger.warn?.({ draftId: queue.draftId, issueNumber: item.issueNumber, error: (error as Error).message }, 'Epic queue retry reservation was not released; it lapses'); }
}

/**
 * Clears the blocker for a retry. Only a closure has a side effect outside the queue: it is reserved
 * first, reopened on GitHub, and the reservation is released if the retry then does not take effect.
 */
async function clearBlockerForRetry(attempt: RetryAttempt, reopenIssue: (repository: string, issueNumber: number) => Promise<void>): Promise<boolean> {
  const { database, queue, item, kind, timestamp } = attempt;
  const reservation = kind === 'closed_unmerged' ? await reserveRetry(attempt) : null;
  let changed = false;
  try {
    if (reservation !== null) {
      const plan = await database('plan_issues').where({ draft_id: queue.draftId, issue_number: item.issueNumber }).first<{ status: string } | undefined>('status');
      if (plan?.status === 'closed') await reopenIssue(queue.repository, item.issueNumber);
    } else await refuseReserved(database, queue, item, timestamp);
    changed = await clearForRetry(attempt, reservation);
  } finally {
    if (reservation !== null && !changed) await releaseRetry(attempt, reservation);
  }
  return changed;
}

async function reopenGithubIssue(repository: string, issueNumber: number): Promise<void> {
  const [owner, repo] = repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber, state: 'open' });
}

/**
 * Retries a blocked issue: its blocker is cleared and the issue is dispatched under the normal guards
 * (a paused plan holds it until resumed; a graph starts it once it is ready and a slot is free).
 * - dispatch_failed, missing_from_plan: the claim is dropped and the issue is dispatched (or re-checked) now.
 * - agent_blocked: the plan issue the run left in progress is put back to pending and dispatched.
 * - closed_unmerged: the issue is reserved for this retry, the GitHub issue is reopened, then handled as above.
 *   A competing skip or retry is refused while the reservation holds; it is released when the retry does not
 *   take effect (the reopen failed or the issue changed) and lapses after RETRY_RESERVATION_MS if the process stops.
 * - awaiting_human_merge, label_handoff: the claim is kept; the queue re-evaluates the merge or the label release.
 * - setup_not_ready is refused: setup recovery owns it.
 * The queue's own dispatch never consults MCP implementation receipts, so an issue started through
 * implement_plan is retried the same way.
 */
export async function retryEpicQueueIssue(input: EpicQueueActionInput, deps: EpicQueueActionDependencies = {}): Promise<EpicQueueActionResult> {
  const database = deps.database ?? db;
  const { queue, item } = await locate(database, input);
  if (item.state !== 'blocked') {
    const latest = await latestBlockedEvent(database, { draftId: queue.draftId, executionId: queue.executionId,
      issueNumber: item.issueNumber, position: item.position });
    if (latest?.type === 'resolved' && latest.resolution === 'retried' && item.state !== 'done') return result(database, input, 'already_retried');
    if (item.state === 'pending') throw new EpicQueueActionError('NOT_BLOCKED', `Issue #${item.issueNumber} is not blocked; the queue starts it in turn.`);
    refuseSettledOrInFlight(item);
  }
  const kind = item.blockedKind;
  if (!kind || kind === 'setup_not_ready' || !queue.ready) {
    throw new EpicQueueActionError('NOT_RETRYABLE', `Issue #${item.issueNumber} is waiting for the execution's setup; recovery completes or cancels it.`);
  }
  const changed = await clearBlockerForRetry({ database, queue, item, kind, timestamp: (deps.now ?? Date.now)() },
    deps.reopenIssue ?? reopenGithubIssue);
  if (!changed) throw new EpicQueueActionError('STATE_CHANGED', `Issue #${item.issueNumber} changed while it was being retried; read the execution queue again.`);
  // Every mode dispatches the retried issue from its own pass, which resume and the recovery sweep repeat:
  // a paused plan, or a process that stops here, leaves the dispatch owed rather than lost.
  await drive(() => startEpicQueueHead(input.draftId, deps), input);
  return result(database, input, 'retried');
}

/** Clears the blocker for a retry, still held by this retry's reservation (or by none, when it reserved nothing). */
async function clearForRetry(attempt: RetryAttempt, reservation: number | null): Promise<boolean> {
  const { database, queue, item, kind, timestamp } = attempt;
  const reclaim = RECLAIMED_KINDS.includes(kind);
  return writeQueueIssue(database, { owner: queue, item, resolution: 'retried', timestamp }, async trx => {
    const query = retryable(trx, attempt);
    if (reservation !== null) query.where({ retry_reserved_at: reservation });
    else unreserved(query, timestamp);
    const cleared = await query
      .update(reclaim
        ? { state: 'pending', dispatched_at: null, blocked_kind: null, blocked_reason: null, blocked_at: null, retry_reserved_at: null, updated_at: timestamp }
        : { ...clearedBlock(trx), retry_reserved_at: null, updated_at: timestamp });
    if (cleared && PLAN_RESET_KINDS.includes(kind)) {
      // A merged issue is never reopened; only the run's own leftover status is reset.
      const reset = trx('plan_issues').where({ draft_id: queue.draftId, issue_number: item.issueNumber }).whereNot('status', 'merged');
      if (kind === 'agent_blocked') reset.whereNot('status', 'closed');
      await reset.update({ status: 'pending' });
    }
    return cleared;
  });
}
