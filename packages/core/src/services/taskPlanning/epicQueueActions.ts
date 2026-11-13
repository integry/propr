import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import {
  clearedBlock, dispatchEpicQueueIssue, getEpicExecutionQueue, ownedIssue, startEpicQueueHead, summarizeEpicQueue, writeQueueIssue,
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
  if (item.state === 'pending' && await runsWithoutClaim(database, queue.draftId, item.issueNumber)) refuseSettledOrInFlight({ ...item, state: 'dispatched' });
  const changed = await writeQueueIssue(database, { owner: queue, item, resolution: 'skipped', timestamp }, trx => {
    const query = ownedIssue(trx, queue, item).where({ state: item.state });
    if (item.state === 'blocked') query.where({ blocked_kind: item.blockedKind });
    // A pending issue a person started meanwhile is in flight.
    else query.whereNull('dispatched_at').whereNotExists(trx('plan_issues').select('id')
      .where({ draft_id: queue.draftId, issue_number: item.issueNumber }).whereNotIn('status', RUNNING_PLAN_STATUSES_EXCLUDED));
    return query.update({ state: 'skipped', skip_satisfies_dependents: satisfies, blocked_kind: null, blocked_reason: null,
      blocked_at: null, updated_at: timestamp });
  });
  if (!changed) throw new EpicQueueActionError('STATE_CHANGED', `Issue #${item.issueNumber} changed while it was being skipped; read the execution queue again.`);
  await drive(() => startEpicQueueHead(input.draftId, deps), input);
  return result(database, input, 'skipped');
}

/** Blockers a retry dispatches afresh: the queue's claim is dropped so the normal dispatch claims the issue again. */
const RECLAIMED_KINDS: EpicQueueBlockedKind[] = ['dispatch_failed', 'agent_blocked', 'closed_unmerged', 'missing_from_plan'];
/** Blockers whose plan issue is left in progress (or closed) by the run; a retry puts it back to pending. */
const PLAN_RESET_KINDS: EpicQueueBlockedKind[] = ['agent_blocked', 'closed_unmerged'];

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
 * - closed_unmerged: the GitHub issue is reopened, then handled as above.
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
  const plan = await database('plan_issues').where({ draft_id: queue.draftId, issue_number: item.issueNumber }).first<{ status: string } | undefined>('status');
  if (kind === 'closed_unmerged' && plan?.status === 'closed') await (deps.reopenIssue ?? reopenGithubIssue)(queue.repository, item.issueNumber);
  const timestamp = (deps.now ?? Date.now)();
  const reclaim = RECLAIMED_KINDS.includes(kind);
  const changed = await writeQueueIssue(database, { owner: queue, item, resolution: 'retried', timestamp }, async trx => {
    const cleared = await ownedIssue(trx, queue, item, { ready: true })
      .where({ state: 'blocked', blocked_kind: kind, blocked_reason: item.blockedReason })
      .update(reclaim
        ? { state: 'pending', dispatched_at: null, blocked_kind: null, blocked_reason: null, blocked_at: null, updated_at: timestamp }
        : { ...clearedBlock(trx), updated_at: timestamp });
    if (cleared && PLAN_RESET_KINDS.includes(kind)) {
      // A merged issue is never reopened; only the run's own leftover status is reset.
      const reset = trx('plan_issues').where({ draft_id: queue.draftId, issue_number: item.issueNumber }).whereNot('status', 'merged');
      if (kind === 'agent_blocked') reset.whereNot('status', 'closed');
      await reset.update({ status: 'pending' });
    }
    return cleared;
  });
  if (!changed) throw new EpicQueueActionError('STATE_CHANGED', `Issue #${item.issueNumber} changed while it was being retried; read the execution queue again.`);
  await drive(async () => {
    if (queue.mode !== 'parallel') return startEpicQueueHead(input.draftId, deps);
    const current = await getEpicExecutionQueue(input.draftId, { database });
    const retried = current?.executionId === queue.executionId ? current.items.find(candidate => candidate.issueNumber === item.issueNumber) : undefined;
    if (current && retried?.state === 'pending') await dispatchEpicQueueIssue(current, retried, deps);
  }, input);
  return result(database, input, 'retried');
}
