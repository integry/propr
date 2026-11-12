import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import { PlanIssueStatus } from '../../config/planIssueManager.js';
import type { EpicAdvancePolicy, EpicExecutionMode } from './epicQueueState.js';
import { isTerminalStatus } from '../../webhook/statusMachine.js';
import { releaseEpicIssueLabels } from './epicIssueLabelHandoff.js';
import {
  blockQueueIssue, clearedBlock, completeSettledExecution, epicQueueSchedule, getEpicExecutionQueue, isSettled,
  markQueueIssueDone, ownedIssue, planIssueWithStatus, type EpicExecutionQueue, type EpicQueueIssue,
} from './epicQueueState.js';

/**
 * Graph executions: an issue is ready once every prerequisite is merged into the epic
 * branch, and at most `max_parallel` issues are in flight. Every pass settles the issues
 * whose plan status is terminal, re-drives the claimed ones, then starts the newly ready
 * issues in publication order under a lock on the execution row, so concurrent advances,
 * the reconcile sweep and a restart never exceed the limit or claim an issue twice.
 */
type StartIssue = (input: { draftId: string; repository: string; issueNumber: number; epicLabel?: string; autoMerge?: boolean }) => Promise<void>;
export interface GraphDriveHooks {
  database: Knex;
  now: () => number;
  startIssue: StartIssue;
  /** Re-drives a claimed pending issue: the queue's own compare-and-set retry after a lost dispatch. */
  retryDispatch: (queue: EpicExecutionQueue, item: EpicQueueIssue, contextConfig: unknown) => Promise<void>;
  /** Runs epic finalization once for the completing execution. */
  finalize: (queue: EpicExecutionQueue) => Promise<void>;
}

/** A graph execution needs edges that only name issues, a positive limit and the merge policy. */
export function assertGraphInput(input: { mode?: EpicExecutionMode; parallel?: boolean; maxParallel?: number | null; advanceOn?: EpicAdvancePolicy;
  issues: number[]; dependsOn?: ReadonlyMap<number, readonly number[]> }): void {
  if (input.mode !== 'graph') {
    if (input.maxParallel !== undefined && input.maxParallel !== null) throw new Error('Only a graph execution stores a parallel limit.');
    return;
  }
  if (input.parallel) throw new Error('A graph execution is not a parallel fan-out.');
  if (input.maxParallel !== undefined && input.maxParallel !== null && (!Number.isInteger(input.maxParallel) || input.maxParallel < 1)) {
    throw new Error('maxParallel must be a positive integer.');
  }
  // Prerequisites must be merged into the epic branch, so a graph advances on merge only.
  if ((input.advanceOn ?? 'merged') !== 'merged') throw new Error('A graph execution advances only when issues are merged.');
  for (const [issue, prerequisites] of input.dependsOn ?? []) {
    if (prerequisites.includes(issue)) throw new Error(`Issue #${issue} cannot depend on itself.`);
  }
}

/** A sequential or parallel execution replacing a graph one must not inherit its mode or limit. */
export async function clearedGraphColumns(trx: Knex): Promise<Record<string, null>> {
  return await trx.schema.hasColumn('epic_execution_queues', 'mode') ? { mode: null, max_parallel: null } : {};
}

type PlanStatusRow = { issue_number: number; status: PlanIssueStatus };

const parseContext = (value: unknown) => {
  const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
};

/**
 * Settles one issue by its persisted plan status: merged is done; closed without merge
 * blocks it, so its dependents keep waiting while other branches run.
 */
async function settleGraphIssue(queue: EpicExecutionQueue, item: EpicQueueIssue, status: PlanIssueStatus, hooks: GraphDriveHooks): Promise<void> {
  const { database } = hooks;
  const timestamp = hooks.now();
  if (status !== PlanIssueStatus.MERGED) {
    if (item.state === 'blocked' && item.blockedKind === 'closed_unmerged') return;
    await blockQueueIssue(database, queue, item, { kind: 'closed_unmerged', timestamp,
      reason: `Issue #${item.issueNumber} is ${status}; issues that depend on it wait until it is merged. Reopen, fix and merge it to continue this branch of the epic.`,
      guard: query => query.whereExists(planIssueWithStatus(database, queue.draftId, [item.issueNumber], true)) });
    return;
  }
  await releaseEpicIssueLabels(queue, { item, status, timestamp }, database);
  await markQueueIssueDone(database, queue, item, { timestamp,
    guard: query => query.whereExists(database('plan_issues').select('id')
      .where({ draft_id: queue.draftId, issue_number: item.issueNumber, status: PlanIssueStatus.MERGED })) });
}

/**
 * An unclaimed issue that was closed (before the queue ever started it) and is reopened: drop the
 * closure block so it is pending again and the scheduler can claim it once its prerequisites merge.
 * Fenced on the persisted status still being non-terminal; other blockers keep their explanation.
 */
async function reopenUnclaimedIssue(queue: EpicExecutionQueue, item: EpicQueueIssue, hooks: GraphDriveHooks): Promise<void> {
  if (item.state !== 'blocked' || item.blockedKind !== 'closed_unmerged') return;
  const { database } = hooks;
  await ownedIssue(database, queue, item).where({ state: 'blocked', blocked_kind: 'closed_unmerged' }).whereNull('dispatched_at')
    .whereExists(planIssueWithStatus(database, queue.draftId, [item.issueNumber], false))
    .update({ ...clearedBlock(database), updated_at: hooks.now() });
}

/** A claimed issue that is not terminal: clear a stale explanation once it is reopened, retry a lost dispatch. */
async function driveClaimedIssue(queue: EpicExecutionQueue, item: EpicQueueIssue,
  { status, contextConfig }: { status: PlanIssueStatus; contextConfig: unknown }, hooks: GraphDriveHooks): Promise<void> {
  // A run stopped on a reported blocker, or a PR waiting for a person, keeps its explanation.
  if (item.blockedKind === 'agent_blocked') return;
  if (item.state === 'blocked' && status !== PlanIssueStatus.PENDING) {
    await ownedIssue(hooks.database, queue, item).where({ state: 'blocked' })
      .whereNotIn('blocked_kind', ['agent_blocked', 'awaiting_human_merge']).update(clearedBlock(hooks.database));
    return;
  }
  if (status === PlanIssueStatus.PENDING) await hooks.retryDispatch(queue, item, contextConfig);
}

/**
 * Claims the issues the scheduler starts now. The execution row is locked first, and each
 * claim is a compare-and-set on the issue's own unclaimed row that also rechecks pause and
 * the plan status, so two passes can never together exceed the limit or claim one issue twice.
 */
async function claimReadyGraphIssues(queue: EpicExecutionQueue, hooks: GraphDriveHooks): Promise<EpicQueueIssue[]> {
  const work = async (trx: Knex): Promise<EpicQueueIssue[]> => {
    const locked = await trx('epic_execution_queues')
      .where({ draft_id: queue.draftId, execution_id: queue.executionId, status: 'active', ready: true }).forUpdate().first('draft_id');
    if (!locked) return [];
    const current = await getEpicExecutionQueue(queue.draftId, { database: trx });
    if (current?.executionId !== queue.executionId || current.mode !== 'graph') return [];
    // Issues a person started (read with the queue, inside the lock) hold a slot without a claim.
    const schedule = epicQueueSchedule(current);
    const timestamp = hooks.now();
    const claimed: EpicQueueIssue[] = [];
    for (const issueNumber of schedule.start) {
      const item = current.items.find(candidate => candidate.issueNumber === issueNumber)!;
      const changed = await ownedIssue(trx, current, item, { ready: true }).where({ state: 'pending' }).whereNull('dispatched_at')
        .whereExists(trx('task_drafts').select('draft_id').where({ draft_id: queue.draftId, paused: false }))
        .whereExists(trx('plan_issues').select('id').where({ draft_id: queue.draftId, issue_number: issueNumber, status: PlanIssueStatus.PENDING }))
        .update({ state: 'dispatched', dispatched_at: timestamp, updated_at: timestamp });
      if (changed) claimed.push({ ...item, state: 'dispatched', dispatchedAt: timestamp });
    }
    return claimed;
  };
  const database = hooks.database;
  return (database as Knex.Transaction).isTransaction ? work(database) : database.transaction(trx => work(trx));
}

/** Starts the claimed issues on the epic branch; a failed start keeps its claim (and slot) and is retried by recovery. */
async function startClaimedIssues(queue: EpicExecutionQueue, claimed: EpicQueueIssue[], contextConfig: unknown, hooks: GraphDriveHooks): Promise<void> {
  const context = parseContext(contextConfig);
  let failure: unknown;
  for (const item of claimed) {
    try {
      // Downstream issues branch from the epic branch, so they contain their prerequisites' merged work.
      await hooks.startIssue({ draftId: queue.draftId, repository: queue.repository, issueNumber: item.issueNumber,
        epicLabel: queue.useEpic && typeof context.epicLabel === 'string' ? context.epicLabel : undefined, autoMerge: queue.autoMerge });
    } catch (error) {
      failure ??= error;
      await blockQueueIssue(hooks.database, queue, item, { kind: 'dispatch_failed', timestamp: hooks.now(),
        reason: `Could not start issue #${item.issueNumber}: ${(error as Error).message}`,
        guard: query => query.where({ dispatched_at: item.dispatchedAt }) });
    }
  }
  if (failure) throw failure;
}

async function driveIssue(queue: EpicExecutionQueue, item: EpicQueueIssue,
  { status, draft }: { status: PlanIssueStatus | undefined; draft: { paused?: unknown; context_config?: unknown } | undefined },
  hooks: GraphDriveHooks): Promise<void> {
  if (status === undefined) {
    if (item.blockedKind !== 'missing_from_plan') await blockQueueIssue(hooks.database, queue, item, { kind: 'missing_from_plan',
      timestamp: hooks.now(), reason: `Selected issue #${item.issueNumber} is missing from this plan.` });
    return;
  }
  // Merge evidence is the persisted plan status, also for an issue a person started out of band.
  if (isTerminalStatus(status)) return settleGraphIssue(queue, item, status, hooks);
  if (item.dispatchedAt === null) return reopenUnclaimedIssue(queue, item, hooks);
  if (!draft || draft.paused) return;
  await driveClaimedIssue(queue, item, { status, contextConfig: draft.context_config }, hooks);
}

/** One pass over a graph execution: settle, re-drive, complete, or start what is ready. */
export async function driveGraphExecution(queue: EpicExecutionQueue, hooks: GraphDriveHooks): Promise<void> {
  const { database } = hooks;
  if (queue.status !== 'active' || !queue.ready) return;
  const statuses = await database('plan_issues').where({ draft_id: queue.draftId }).whereIn('issue_number', queue.issues)
    .select<PlanStatusRow[]>('issue_number', 'status');
  const draft = await database('task_drafts').where({ draft_id: queue.draftId }).first('paused', 'context_config');
  for (const item of queue.items.filter(candidate => !isSettled(candidate))) {
    // One branch failing (a label handoff, a lost dispatch) never stops the others; recovery retries it.
    try { await driveIssue(queue, item, { status: statuses.find(row => row.issue_number === item.issueNumber)?.status, draft }, hooks); }
    catch (error) {
      logger.warn({ draftId: queue.draftId, issueNumber: item.issueNumber, error: (error as Error).message }, 'Failed to drive epic graph issue');
    }
  }
  const current = await getEpicExecutionQueue(queue.draftId, { database });
  if (current?.executionId !== queue.executionId || current.status !== 'active') return;
  if (current.items.every(isSettled)) {
    if (await completeSettledExecution(database, current, hooks.now())) await hooks.finalize(current);
    return;
  }
  if (!draft || draft.paused) return;
  const claimed = await claimReadyGraphIssues(current, hooks);
  if (claimed.length) await startClaimedIssues(current, claimed, draft.context_config, hooks);
}
