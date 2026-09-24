/**
 * Task state — the dashboard's first source of truth.
 *
 * Running, queued and blocked work, plus the plan issues awaiting a human
 * decision, are loaded and projected here so `/api/dashboard/summary`,
 * `/api/dashboard/active`, `/api/dashboard/attention` and the task pages cannot
 * drift apart.
 *
 * Attention is derived from work state only. Notification read/dismissal state
 * lives in `notification_user_states` and is deliberately never read here:
 * dismissing a notification must not resolve a blocker.
 */

import type { Knex } from 'knex';
// Type-only: the enum's runtime module reaches the shared DB connection, which
// route modules must not import. The assertion below keeps the literals below
// tied to `PlanIssueStatus` at compile time.
import type { PlanIssueStatus } from '@propr/core';
import {
  ATTENTION_TASK_STATES,
  chunk,
  isAttentionState,
  isQueuedState,
  isRunningState,
  latestTaskStateQuery,
  loadThreadWork,
  mapTaskRow,
  MAX_WORK_ROWS,
  QUEUED_TASK_STATES,
  RECENT_COMPLETION_WINDOW_HOURS,
  RUNNING_TASK_STATES,
  TASK_COLUMNS,
  threadTitle,
  toIso,
  WORK_LOOKBACK_DAYS,
  workKey,
  type DashboardTaskRow,
  type RawTaskRow,
} from './dashboardQueries.js';

/**
 * Plan issue statuses that await a human decision.
 *
 * `under_review` means a pull request is open and nobody has decided about it
 * yet. `pending` (never started) is backlog, and `in_refinement` /
 * `refinement_processing` / `processing` are states the system is working
 * through on its own, so none of them belong in an attention list.
 */
export const HUMAN_DECISION_PLAN_ISSUE_STATUSES = ['under_review'] as const;

// Compile-time proof that the literals above remain real PlanIssueStatus values.
type AssertPlanIssueStatuses =
  typeof HUMAN_DECISION_PLAN_ISSUE_STATUSES[number] extends `${PlanIssueStatus}` ? true : never;
const PLAN_ISSUE_STATUSES_ARE_VALID: AssertPlanIssueStatuses = true;
void PLAN_ISSUE_STATUSES_ARE_VALID;

/** A completion that can supersede a failure in the same thread. */
export interface ThreadCompletion {
  key: string;
  completedAt: string;
}

/**
 * One dashboard read's task rows, split by how each set may be bounded.
 *
 * `open` and `failed` decide counts the dashboard states as fact, so neither
 * is truncated. Only `recentlyCompleted` — a display sample — carries a row
 * limit, and the count beside it is read from the database rather than from
 * the sample, so a limit can never shrink a number.
 */
export interface DashboardWorkRows {
  /** Every task whose latest state is running, queued or action-required. */
  open: DashboardTaskRow[];
  /** Every task whose latest state is a failure inside the lookback window. */
  failed: DashboardTaskRow[];
  /** Completions that could supersede one of `failed`, whatever the row limit. */
  supersedingCompletions: ThreadCompletion[];
  /** A bounded, newest-first sample of completions inside the recent window. */
  recentlyCompleted: DashboardTaskRow[];
  /** How many completions the recent window actually holds. */
  completedRecentlyCount: number;
}

/**
 * Completions that can retire one of the loaded failures.
 *
 * Only the issue threads that actually have a failure are read, so recovery
 * detection stays correct without loading every completion on the instance.
 * A failure on a task with no issue number is its own thread, and that task's
 * latest state is the failure, so no completion can supersede it.
 */
async function loadSupersedingCompletions(
  db: Knex,
  repository: string,
  failed: readonly DashboardTaskRow[],
  since: string,
): Promise<ThreadCompletion[]> {
  const issueNumbers = [...new Set(
    failed.map(row => row.issueNumber).filter((value): value is number => value !== null),
  )];
  if (issueNumbers.length === 0) return [];

  const completions: ThreadCompletion[] = [];
  for (const batch of chunk(issueNumbers)) {
    const rows = await latestTaskStateQuery(db, repository)
      .where('h.state', 'completed')
      .where('h.timestamp', '>=', since)
      .whereIn('t.issue_number', batch)
      .select('t.task_id', 't.repository', 't.issue_number', 'h.timestamp as state_timestamp') as Array<Record<string, unknown>>;
    for (const row of rows) {
      completions.push({
        key: workKey({
          repository: String(row.repository),
          issueNumber: row.issue_number === null || row.issue_number === undefined ? null : Number(row.issue_number),
          taskId: String(row.task_id),
        }),
        completedAt: toIso(row.state_timestamp),
      });
    }
  }
  return completions;
}

/**
 * Loads the open work set plus the finished work the dashboard reasons about.
 *
 * Open work and unresolved failures are read in full: they are what the
 * running, queued and attention counts describe. Completed work is bounded by
 * `WORK_LOOKBACK_DAYS` because a completion older than that cannot retire a
 * listed failure, and the recent-completion sample is bounded by
 * `MAX_WORK_ROWS` while its count is aggregated in the database.
 */
export async function loadDashboardWorkRows(
  db: Knex,
  repository: string,
  options: { now?: Date; lookbackDays?: number; recentWindowHours?: number } = {},
): Promise<DashboardWorkRows> {
  const now = options.now ?? new Date();
  const lookbackDays = options.lookbackDays ?? WORK_LOOKBACK_DAYS;
  const lookback = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const recentWindowHours = options.recentWindowHours ?? RECENT_COMPLETION_WINDOW_HOURS;
  const recentSince = new Date(now.getTime() - recentWindowHours * 60 * 60 * 1000).toISOString();
  const openStates = [...RUNNING_TASK_STATES, ...QUEUED_TASK_STATES, ...ATTENTION_TASK_STATES];

  const recentCompletions = (): Knex.QueryBuilder => latestTaskStateQuery(db, repository)
    .where('h.state', 'completed')
    .where('h.timestamp', '>=', recentSince);

  const [openRows, failedRows, recentRows, recentCount] = await Promise.all([
    latestTaskStateQuery(db, repository)
      .whereIn('h.state', openStates)
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc') as unknown as Promise<RawTaskRow[]>,
    latestTaskStateQuery(db, repository)
      .where('h.state', 'failed')
      .where('h.timestamp', '>=', lookback)
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc') as unknown as Promise<RawTaskRow[]>,
    recentCompletions()
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc')
      .limit(MAX_WORK_ROWS) as unknown as Promise<RawTaskRow[]>,
    recentCompletions().count({ total: '*' }).first() as Promise<{ total?: number | string } | undefined>,
  ]);

  const failed = failedRows.map(mapTaskRow);
  return {
    open: openRows.map(mapTaskRow),
    failed,
    supersedingCompletions: await loadSupersedingCompletions(db, repository, failed, lookback),
    recentlyCompleted: recentRows.map(mapTaskRow),
    completedRecentlyCount: Number(recentCount?.total ?? 0),
  };
}

export interface PlanIssueDecisionRow {
  id: number;
  repository: string;
  issueNumber: number;
  prNumber: number | null;
  status: string;
  /** What the work under review is about, from the run that produced it. */
  title: string | null;
  taskId: string | null;
  updatedAt: string;
}

/** Plan issues waiting on a human decision, oldest first. */
export async function loadPlanIssueDecisions(db: Knex, repository: string): Promise<PlanIssueDecisionRow[]> {
  const query = db('plan_issues')
    .whereIn('status', [...HUMAN_DECISION_PLAN_ISSUE_STATUSES])
    .select('id', 'repository', 'issue_number', 'pr_number', 'status', 'task_id', 'updated_at')
    .orderBy('updated_at', 'asc')
    .limit(MAX_WORK_ROWS);
  if (repository && repository !== 'all') query.where('repository', repository);

  const rows = await query as Array<Record<string, unknown>>;
  const decisions = rows.map(row => ({
    id: Number(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    status: String(row.status),
    title: null,
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    updatedAt: toIso(row.updated_at),
  }));

  /*
    A plan issue records neither a title of its own nor, in older rows, the
    task that produced it. Both come from the runs on its thread: the task
    identity so the list a count opens is the work the count is about, and the
    title so a review row says what is being reviewed rather than repeating
    the chip beside it.
  */
  const threads = await loadThreadWork(db, repository, decisions.map(row => row.issueNumber));
  return decisions.map(decision => ({
    ...decision,
    title: threadTitle(threads, decision),
    taskId: decision.taskId ?? threads.byThread.get(`${decision.repository}#${decision.issueNumber}`)?.taskId ?? null,
  }));
}

export interface AttentionItem {
  id: string;
  category: 'blocked' | 'decision';
  kind: 'task_failed' | 'task_action_required' | 'plan_review';
  taskId: string | null;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  title: string | null;
  state: string;
  detail: string | null;
  since: string;
}

export interface DashboardWorkProjection {
  running: DashboardTaskRow[];
  queued: DashboardTaskRow[];
  attention: AttentionItem[];
  /** A capped sample; `counts.completedRecently` is the real total. */
  recentlyCompleted: DashboardTaskRow[];
  counts: {
    needsAttention: number;
    running: number;
    queued: number;
    completedRecently: number;
  };
}

/**
 * Derives every dashboard work list and count from one row set.
 *
 * Recovery-aware exclusion: a failure is suppressed while the same thread has
 * running or queued work, or once a later run of that thread has completed.
 * The system is already fixing it, so it belongs in `active`, not `attention`.
 */
export function projectDashboardWork(
  rows: DashboardWorkRows,
  planIssues: readonly PlanIssueDecisionRow[],
): DashboardWorkProjection {
  const running: DashboardTaskRow[] = [];
  const queued: DashboardTaskRow[] = [];
  const attentionRows: DashboardTaskRow[] = [];
  const recovering = new Set<string>();
  const completedAt = new Map<string, number>();

  for (const row of rows.open) {
    const key = workKey(row);
    if (isRunningState(row.state)) {
      running.push(row);
      recovering.add(key);
    } else if (isQueuedState(row.state)) {
      queued.push(row);
      recovering.add(key);
    } else if (isAttentionState(row.state)) {
      attentionRows.push(row);
    }
  }

  for (const completion of rows.supersedingCompletions) {
    const timestamp = Date.parse(completion.completedAt);
    completedAt.set(completion.key, Math.max(completedAt.get(completion.key) ?? 0, timestamp));
  }

  const blocked: AttentionItem[] = [];
  for (const row of attentionRows) {
    blocked.push({
      id: `task:${row.taskId}`,
      category: 'blocked',
      kind: 'task_action_required',
      taskId: row.taskId,
      repository: row.repository,
      issueNumber: row.issueNumber,
      prNumber: row.prNumber,
      title: row.title,
      state: row.state,
      detail: row.reason,
      since: row.stateTimestamp,
    });
  }
  for (const row of rows.failed) {
    const key = workKey(row);
    // Already being retried or auto-recovered, or superseded by a later success.
    if (recovering.has(key)) continue;
    if ((completedAt.get(key) ?? 0) > Date.parse(row.stateTimestamp)) continue;
    blocked.push({
      id: `task:${row.taskId}`,
      category: 'blocked',
      kind: 'task_failed',
      taskId: row.taskId,
      repository: row.repository,
      issueNumber: row.issueNumber,
      prNumber: row.prNumber,
      title: row.title,
      state: row.state,
      detail: row.reason,
      since: row.stateTimestamp,
    });
  }

  const decisions: AttentionItem[] = planIssues.map(issue => ({
    id: `plan-issue:${issue.id}`,
    category: 'decision' as const,
    kind: 'plan_review' as const,
    taskId: issue.taskId,
    repository: issue.repository,
    issueNumber: issue.issueNumber,
    prNumber: issue.prNumber,
    // What the pull request is about, resolved from the run that produced it.
    // The identifier is already on the row as a chip; the title must not be it.
    title: issue.title,
    state: issue.status,
    detail: issue.status === 'under_review' ? 'Pull request is awaiting review' : null,
    since: issue.updatedAt,
  }));

  const oldestFirst = (a: AttentionItem, b: AttentionItem): number =>
    Date.parse(a.since) - Date.parse(b.since);
  // Blocking problems first, then pending decisions; oldest first within each.
  const attention = [...blocked.sort(oldestFirst), ...decisions.sort(oldestFirst)];

  const byOldest = (a: DashboardTaskRow, b: DashboardTaskRow): number =>
    Date.parse(a.stateTimestamp) - Date.parse(b.stateTimestamp);

  return {
    running: [...running].sort(byOldest),
    queued: [...queued].sort(byOldest),
    attention,
    recentlyCompleted: rows.recentlyCompleted,
    counts: {
      needsAttention: attention.length,
      running: running.length,
      queued: queued.length,
      // Counted in the database: the sample above is capped for display, and a
      // display cap must never be reported as how much work finished.
      completedRecently: rows.completedRecentlyCount,
    },
  };
}

/**
 * The task identities behind the attention list.
 *
 * The attention count links to a task list, and that list has to be the same
 * work: the same recovery exclusions, the same plan reviews awaiting a
 * decision, and the runs behind decisions that never recorded a task link. So
 * the list is built from this projection rather than from a second guess at
 * what "needs attention" means.
 */
export async function loadAttentionTaskIds(
  db: Knex,
  repository: string,
  options: { now?: Date } = {},
): Promise<string[]> {
  const work = await loadDashboardWork(db, repository, options);
  const taskIds: string[] = [];
  const seen = new Set<string>();
  for (const item of work.attention) {
    if (item.taskId === null || seen.has(item.taskId)) continue;
    seen.add(item.taskId);
    taskIds.push(item.taskId);
  }
  return taskIds;
}

/** One dashboard read of every work source, already projected. */
export async function loadDashboardWork(
  db: Knex,
  repository: string,
  options: { now?: Date; lookbackDays?: number; recentWindowHours?: number } = {},
): Promise<DashboardWorkProjection> {
  const [rows, planIssues] = await Promise.all([
    loadDashboardWorkRows(db, repository, options),
    loadPlanIssueDecisions(db, repository),
  ]);
  return projectDashboardWork(rows, planIssues);
}
