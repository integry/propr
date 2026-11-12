import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import { epicScheduleState, executionEdges, executionLimit, scheduleEpicIssues, type EpicExecutionMode, type EpicSchedule,
  type EpicScheduleIssue } from './epicQueueSchedule.js';

export type { EpicExecutionMode } from './epicQueueSchedule.js';

export type EpicAdvancePolicy = 'merged' | 'terminal';
export type EpicQueueStatus = 'active' | 'completed' | 'cancelled';
/** Lifecycle of one issue in an execution. `dispatched` is the queue's own claim, not `plan_issues.status`. */
export type EpicQueueIssueState = 'pending' | 'dispatched' | 'done' | 'blocked' | 'skipped';
/** Why a blocked issue holds its execution. */
export type EpicQueueBlockedKind =
  | 'closed_unmerged' // closed without merge under the merged advance policy
  | 'missing_from_plan'
  | 'dispatch_failed'
  | 'agent_blocked' // the run stopped on a blocker reported by the agent; never re-dispatched by recovery
  | 'awaiting_human_merge'
  | 'label_handoff' // processing labels are not released yet
  | 'setup_not_ready'; // initial model and branch selectors are not synchronized

export interface EpicQueueIssue {
  issueNumber: number;
  position: number;
  state: EpicQueueIssueState;
  /** The issue's own dispatch claim; kept while blocked so the retry window still applies. */
  dispatchedAt: number | null;
  blockedKind: EpicQueueBlockedKind | null;
  blockedReason: string | null;
  blockedAt: number | null;
  updatedAt: number;
  /** Prerequisites recorded when a graph execution started; empty in the other modes. */
  dependsOn: number[];
}

export interface EpicExecutionQueue {
  draftId: string;
  executionId: string;
  repository: string;
  /** Issue numbers in queue order. */
  issues: number[];
  /** Per-issue state in queue order. */
  items: EpicQueueIssue[];
  /** Derived: index of the sequential head (issues.length once completed; 0 for an unfinished parallel execution). */
  cursor: number;
  status: EpicQueueStatus;
  advanceOn: EpicAdvancePolicy;
  /** Derived: the head's (or, in parallel, the latest blocked child's) reason, or an execution-wide note. */
  blockedReason: string | null;
  /** The cancelled execution never dispatched its head, so implementation may be requested again. */
  unstarted: boolean;
  autoMerge: boolean;
  /** Non-epic auto-merge queues start successors without the plan's epic branch label. */
  useEpic: boolean;
  /** Parallel epics dispatch every child up front; the row only owes epic finalization. */
  parallel: boolean;
  /** sequential: a chain with a limit of one; parallel: no edges; graph: the plan's dependsOn edges. */
  mode: EpicExecutionMode;
  /** The stored in-flight limit of a graph execution (null: unbounded). */
  maxParallel: number | null;
  /** Prerequisites outside a graph execution that are merged (satisfied); read with the queue. */
  mergedOutside: number[];
  /** Durable initial dispatch intent; plan_issues retains the old model for label removal. */
  headSelection: { agent_alias: string; model_name: string } | null;
  /** Outstanding epic completion labeling, independent of the current children's branch. */
  owesEpicFinalization: boolean;
  ready: boolean;
  /** Derived: the sequential head's dispatch claim. */
  headStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
  finalizationStartedAt: number | null;
}

export const EPIC_QUEUE_ISSUES = 'epic_execution_queue_issues';
export const SETTLED_STATES: EpicQueueIssueState[] = ['done', 'skipped'];
export const UNSTARTED_EPIC_REASON = 'Initial queue head never started; implementation may be requested again.';
export const SETUP_PENDING_REASON = 'Preparing queued issue model and epic branch labels.';

type QueueRow = {
  draft_id: string; execution_id: string; repository: string; issues: string; cursor: number;
  status: EpicQueueStatus; advance_on: EpicAdvancePolicy; blocked_reason: string | null;
  auto_merge: boolean | number; use_epic: boolean | number; parallel: boolean | number; ready: boolean | number;
  head_selection: string | null; owes_epic_finalization: boolean | number;
  mode?: EpicExecutionMode | null; max_parallel?: number | null;
  created_at: number; updated_at: number; finalized_at: number | null; finalization_started_at: number | null;
};
type IssueRow = {
  issue_number: number; position: number; state: EpicQueueIssueState; dispatched_at: number | string | null;
  blocked_kind: EpicQueueBlockedKind | null; blocked_reason: string | null; blocked_at: number | string | null; updated_at: number | string;
  depends_on?: string | null;
};

const toNumber = (value: number | string | null): number | null => value === null || value === undefined ? null : Number(value);

export function isSettled(item: EpicQueueIssue): boolean {
  return SETTLED_STATES.includes(item.state);
}

function parseDependsOn(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((issue): issue is number => Number.isInteger(issue)) : [];
  } catch {
    return [];
  }
}

export function executionModeOf(row: { mode?: EpicExecutionMode | null; parallel: boolean | number }): EpicExecutionMode {
  return row.mode === 'graph' || row.mode === 'sequential' || row.mode === 'parallel' ? row.mode : row.parallel ? 'parallel' : 'sequential';
}

function fromRows(row: QueueRow, rows: IssueRow[], mergedOutside: number[]): EpicExecutionQueue {
  const mode = executionModeOf(row);
  const items = rows.map(item => ({
    issueNumber: item.issue_number, position: item.position, state: item.state, dispatchedAt: toNumber(item.dispatched_at),
    blockedKind: item.blocked_kind, blockedReason: item.blocked_reason, blockedAt: toNumber(item.blocked_at), updatedAt: Number(item.updated_at),
    dependsOn: mode === 'graph' ? parseDependsOn(item.depends_on) : [],
  }));
  const parallel = mode === 'parallel';
  // Only a chain has a head; a parallel or graph execution has a set of in-flight issues.
  const chain = mode === 'sequential';
  const completed = row.status === 'completed';
  const headIndex = !chain || completed ? -1 : items.findIndex(item => !isSettled(item));
  const head = headIndex === -1 ? undefined : items[headIndex];
  const cursor = completed ? items.length : !chain ? 0 : headIndex === -1 ? items.length : headIndex;
  const issueReason = !chain ? latestBlocked(items)?.blockedReason : head?.state === 'blocked' ? head.blockedReason : null;
  return {
    draftId: row.draft_id, executionId: row.execution_id, repository: row.repository,
    issues: items.map(item => item.issueNumber), items, cursor, status: row.status, advanceOn: row.advance_on,
    blockedReason: row.blocked_reason ?? issueReason ?? null,
    unstarted: row.status === 'cancelled' && row.blocked_reason === UNSTARTED_EPIC_REASON,
    autoMerge: Boolean(row.auto_merge), useEpic: Boolean(row.use_epic), parallel, ready: Boolean(row.ready),
    mode, maxParallel: mode === 'graph' && row.max_parallel !== null && row.max_parallel !== undefined ? Number(row.max_parallel) : null,
    mergedOutside,
    headSelection: row.head_selection ? JSON.parse(row.head_selection) : null,
    owesEpicFinalization: Boolean(row.owes_epic_finalization),
    headStartedAt: head?.dispatchedAt ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    finalizedAt: row.finalized_at, finalizationStartedAt: row.finalization_started_at,
  };
}

/** The most recently blocked issue; a parallel execution explains itself with its latest blocker. */
function latestBlocked(items: EpicQueueIssue[]): EpicQueueIssue | undefined {
  return items.filter(item => item.state === 'blocked')
    .sort((left, right) => (right.blockedAt ?? 0) - (left.blockedAt ?? 0) || right.position - left.position)[0];
}

export async function getEpicExecutionQueue(draftId: string, { database = db }: { database?: Knex } = {}): Promise<EpicExecutionQueue | null> {
  const row = await database('epic_execution_queues').where({ draft_id: draftId }).first<QueueRow | undefined>();
  if (!row) return null;
  const graph = executionModeOf(row) === 'graph';
  const items = await database(EPIC_QUEUE_ISSUES).where({ draft_id: draftId, execution_id: row.execution_id })
    .orderBy('position').select<IssueRow[]>('issue_number', 'position', 'state', 'dispatched_at', 'blocked_kind', 'blocked_reason', 'blocked_at',
      'updated_at', ...(graph ? ['depends_on'] : []));
  return fromRows(row, items, graph ? await mergedOutsidePrerequisites(database, draftId, items) : []);
}

/** A prerequisite that is not part of the execution counts as satisfied only once its plan issue is merged. */
async function mergedOutsidePrerequisites(database: Knex, draftId: string, items: IssueRow[]): Promise<number[]> {
  const inExecution = new Set(items.map(item => item.issue_number));
  const outside = [...new Set(items.flatMap(item => parseDependsOn(item.depends_on)))].filter(issue => !inExecution.has(issue));
  if (!outside.length) return [];
  return database('plan_issues').where({ draft_id: draftId, status: 'merged' }).whereIn('issue_number', outside).pluck('issue_number');
}

/** The issue a sequential execution is working on: its first issue that is neither done nor skipped. */
export function epicQueueHead(queue: EpicExecutionQueue | null): EpicQueueIssue | null {
  if (!queue || queue.mode !== 'sequential' || queue.status === 'completed') return null;
  return queue.items.find(item => !isSettled(item)) ?? null;
}

export function epicQueueIssue(queue: EpicExecutionQueue | null, issueNumber: number): EpicQueueIssue | null {
  return queue?.items.find(item => item.issueNumber === issueNumber) ?? null;
}

/**
 * Whether the issue is in flight in an active execution: its sequential head, an unsettled parallel child,
 * or an unsettled graph issue the queue claimed (an unclaimed one still waits for its turn).
 */
export function isEpicQueueIssueInFlight(queue: EpicExecutionQueue | null, issueNumber: number): boolean {
  if (queue?.status !== 'active') return false;
  if (queue.mode === 'sequential') return epicQueueHead(queue)?.issueNumber === issueNumber;
  const item = epicQueueIssue(queue, issueNumber);
  return Boolean(item && !isSettled(item) && (queue.mode === 'parallel' || item.dispatchedAt !== null));
}

/** The execution's issues as the scheduler sees them: edges and slots follow the mode. */
export function epicScheduleIssues(queue: EpicExecutionQueue, inProgress: ReadonlySet<number> = new Set()): EpicScheduleIssue[] {
  const edges = executionEdges(queue.mode, queue.items);
  return queue.items.map((item, index) => ({ issueNumber: item.issueNumber, position: item.position, state: item.state,
    dependsOn: edges[index], inFlight: !isSettled(item) && (item.dispatchedAt !== null || item.state === 'dispatched' || inProgress.has(item.issueNumber)) }));
}

/** The execution's current schedule; `inProgress` adds issues that run without a queue claim. */
export function epicQueueSchedule(queue: EpicExecutionQueue, inProgress?: ReadonlySet<number>): EpicSchedule {
  return scheduleEpicIssues({ issues: epicScheduleIssues(queue, inProgress), mergedOutside: queue.mergedOutside,
    limit: executionLimit(queue.mode, queue.maxParallel) });
}

export function summarizeEpicQueue(queue: EpicExecutionQueue | null) {
  if (!queue) return null;
  const scheduled = epicScheduleIssues(queue);
  const schedule = epicQueueSchedule(queue);
  return { issues: queue.issues, cursor: queue.cursor, head: queue.mode === 'sequential' ? queue.issues[queue.cursor] ?? null : null,
    status: queue.status, advanceOn: queue.advanceOn, blockedReason: queue.blockedReason,
    executionMode: queue.mode, maxParallel: executionLimit(queue.mode, queue.maxParallel),
    issueStates: queue.items.map((item, index) => ({ issue: item.issueNumber, state: item.state,
      blockedKind: item.state === 'blocked' ? item.blockedKind : null, blockedReason: item.state === 'blocked' ? item.blockedReason : null,
      // waiting (on waitingOn), ready, in_flight, done, skipped or blocked.
      schedule: epicScheduleState(scheduled[index], schedule),
      dependsOn: scheduled[index].dependsOn,
      waitingOn: schedule.waiting.get(item.issueNumber) ?? [] })) };
}

/**
 * Initial per-issue rows: a parallel execution dispatched every child at request time; a sequential
 * or graph execution dispatched only its first issue (the one that establishes the epic branch).
 */
export function initialIssueRows(input: { draftId: string; executionId: string; issues: number[]; parallel: boolean;
  ready: boolean; headStartedAt: number | null; timestamp: number; dependsOn?: ReadonlyMap<number, readonly number[]> }) {
  return input.issues.map((issueNumber, position) => {
    const dispatchedAt = input.parallel ? input.timestamp : position === 0 ? input.headStartedAt : null;
    const setup = !input.ready && !input.parallel && position === 0;
    return {
      ...(input.dependsOn ? { depends_on: JSON.stringify([...(input.dependsOn.get(issueNumber) ?? [])]) } : {}),
      draft_id: input.draftId, execution_id: input.executionId, issue_number: issueNumber, position,
      state: setup ? 'blocked' : dispatchedAt === null ? 'pending' : 'dispatched', dispatched_at: dispatchedAt,
      blocked_kind: setup ? 'setup_not_ready' : null, blocked_reason: setup ? SETUP_PENDING_REASON : null,
      blocked_at: setup ? input.timestamp : null, created_at: input.timestamp, updated_at: input.timestamp,
    };
  });
}

type Owner = { draftId: string; executionId: string };
/**
 * One occurrence of an issue in an execution. A requeue moves the row to a new tail position,
 * so the position an observer read identifies the occurrence it observed.
 */
export type QueueIssueRef = Pick<EpicQueueIssue, 'issueNumber' | 'position'>;

/**
 * One issue's row, while its execution is still the plan's active one (plus any further
 * queue conditions) and the row is still the occurrence the caller read. Every per-issue
 * write starts here, so a stale execution, or a delayed observer of an earlier occurrence
 * of a since-requeued issue, never writes.
 */
export function ownedIssue(database: Knex, owner: Owner, item: QueueIssueRef, queueWhere: Record<string, unknown> = {}): Knex.QueryBuilder {
  return database(EPIC_QUEUE_ISSUES)
    .where({ draft_id: owner.draftId, execution_id: owner.executionId, issue_number: item.issueNumber, position: item.position })
    .whereExists(database('epic_execution_queues').select('draft_id')
      .where({ draft_id: owner.draftId, execution_id: owner.executionId, status: 'active', ...queueWhere }));
}

/** Blocks an unsettled issue with a structured reason; the dispatch claim is kept. */
export async function blockQueueIssue(database: Knex, owner: Owner, item: QueueIssueRef, blocked: {
  kind: EpicQueueBlockedKind; reason: string; timestamp: number; guard?: (query: Knex.QueryBuilder) => void;
}): Promise<boolean> {
  const query = ownedIssue(database, owner, item).whereNotIn('state', SETTLED_STATES);
  blocked.guard?.(query);
  return Boolean(await query.update({ state: 'blocked', blocked_kind: blocked.kind, blocked_reason: blocked.reason,
    blocked_at: blocked.timestamp, updated_at: blocked.timestamp }));
}

/** Drops a blocked issue's reason (only of the given kinds, when listed); it returns to dispatched while it holds a claim. */
export async function unblockQueueIssue(database: Knex, owner: Owner, item: QueueIssueRef,
  { timestamp, kinds, queueWhere }: { timestamp: number; kinds?: EpicQueueBlockedKind[]; queueWhere?: Record<string, unknown> }): Promise<boolean> {
  const query = ownedIssue(database, owner, item, queueWhere).where({ state: 'blocked' });
  if (kinds) query.whereIn('blocked_kind', kinds);
  return Boolean(await query.update({ ...clearedBlock(database), updated_at: timestamp }));
}

export function clearedBlock(database: Knex) {
  return { state: database.raw('CASE WHEN dispatched_at IS NULL THEN ? ELSE ? END', ['pending', 'dispatched']),
    blocked_kind: null, blocked_reason: null, blocked_at: null };
}

type Guard = (query: Knex.QueryBuilder) => void;

/** Settles the observed occurrence as done. Only one observer wins; the others see zero changed rows. */
export async function markQueueIssueDone(database: Knex, owner: Owner, item: QueueIssueRef,
  { timestamp, guard }: { timestamp: number; guard?: Guard }): Promise<boolean> {
  const query = ownedIssue(database, owner, item).whereNotIn('state', SETTLED_STATES);
  guard?.(query);
  return Boolean(await query.update({ state: 'done', blocked_kind: null, blocked_reason: null, blocked_at: null, updated_at: timestamp }));
}

/** Completes the active execution once every issue is settled. Returns true for the single winner. */
export async function completeSettledExecution(database: Knex, owner: Owner, timestamp: number, guard?: Guard): Promise<boolean> {
  const query = database('epic_execution_queues')
    .where({ draft_id: owner.draftId, execution_id: owner.executionId, status: 'active' })
    .whereNotExists(database(EPIC_QUEUE_ISSUES).select('issue_number')
      .where({ draft_id: owner.draftId, execution_id: owner.executionId }).whereNotIn('state', SETTLED_STATES));
  guard?.(query);
  return Boolean(await query.update({ status: 'completed', blocked_reason: null, updated_at: timestamp }));
}

/**
 * The issue's current plan status, (non)terminal as `isTerminalStatus` defines it (merged or closed), for a guard
 * in the same statement as a queue write. Literal statuses: suites mock the plan issue manager with partial exports.
 */
export function planIssueWithStatus(database: Knex, draftId: string, issueNumbers: number[], terminal: boolean): Knex.QueryBuilder {
  const statuses = ['merged', 'closed'];
  const query = database('plan_issues').select('id').where({ draft_id: draftId }).whereIn('issue_number', issueNumbers);
  return terminal ? query.whereIn('status', statuses) : query.whereNotIn('status', statuses);
}

/**
 * A parallel child settles when its plan issue becomes terminal, but it can be reopened and
 * processed again while its siblings still run. Its row is then back in flight, so blocker
 * handling and recovery track the new run. Fenced on the current plan status, so a delayed
 * observer of the earlier terminal status never reopens a child that settled again.
 */
export async function reopenParallelQueueIssue(database: Knex, owner: Owner, item: QueueIssueRef, timestamp: number): Promise<boolean> {
  return Boolean(await ownedIssue(database, owner, item, { parallel: true }).whereIn('state', SETTLED_STATES)
    .whereExists(planIssueWithStatus(database, owner.draftId, [item.issueNumber], false))
    .update({ state: 'dispatched', dispatched_at: timestamp, blocked_kind: null, blocked_reason: null, blocked_at: null, updated_at: timestamp }));
}

/**
 * Appends pending issues to an active sequential execution, as long as it still holds exactly
 * the issues the caller read: a concurrent advance or completion is never overwritten. An issue
 * that already settled in this execution is requeued: its row is reset to pending at the tail.
 */
export async function appendEpicQueueIssues(queue: EpicExecutionQueue, issueNumbers: number[],
  { database = db, now = Date.now }: { database?: Knex; now?: () => number } = {}): Promise<boolean> {
  if (!issueNumbers.length || new Set(issueNumbers).size !== issueNumbers.length) return false;
  // Only settled issues may be requeued; an unsettled one is already owed by the execution.
  if (issueNumbers.some(issue => { const item = epicQueueIssue(queue, issue); return item && !isSettled(item); })) return false;
  const timestamp = now();
  const work = async (trx: Knex) => {
    const owned = { draft_id: queue.draftId, execution_id: queue.executionId };
    const current = await trx('epic_execution_queues').where({ ...owned, status: 'active' }).forUpdate().first('draft_id');
    if (!current) return false;
    const items = await trx(EPIC_QUEUE_ISSUES).where(owned).orderBy('position')
      .select<Array<{ issue_number: number; position: number; state: EpicQueueIssueState }>>('issue_number', 'position', 'state');
    if (items.length !== queue.items.length || items.some((item, index) => item.issue_number !== queue.items[index].issueNumber)) return false;
    // A requeued issue must still be settled; nothing but an append moves a settled row back.
    if (issueNumbers.some(issue => items.some(item => item.issue_number === issue && !SETTLED_STATES.includes(item.state)))) return false;
    let next = (items.at(-1)?.position ?? -1) + 1;
    const pending = { state: 'pending', dispatched_at: null, blocked_kind: null, blocked_reason: null, blocked_at: null, updated_at: timestamp };
    for (const issueNumber of issueNumbers) {
      const position = next++;
      if (!items.some(item => item.issue_number === issueNumber)) {
        await trx(EPIC_QUEUE_ISSUES).insert({ ...owned, issue_number: issueNumber, position, ...pending, created_at: timestamp });
        continue;
      }
      await trx(EPIC_QUEUE_ISSUES).where({ ...owned, issue_number: issueNumber }).whereIn('state', SETTLED_STATES)
        .update({ ...pending, position });
    }
    const order = await trx(EPIC_QUEUE_ISSUES).where(owned).orderBy('position').pluck('issue_number');
    await trx('epic_execution_queues').where(owned).update({ issues: JSON.stringify(order), updated_at: timestamp });
    return true;
  };
  return (database as Knex.Transaction).isTransaction ? work(database) : database.transaction(trx => work(trx));
}
