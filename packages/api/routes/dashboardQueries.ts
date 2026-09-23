/**
 * Shared dashboard queries.
 *
 * The dashboard answers four questions from three sources of truth: task state
 * (running, queued, blocked), outcome events (recent history) and aggregated
 * execution data (stats). Every count the dashboard shows is derived here so
 * `/api/dashboard/summary`, `/api/dashboard/active`, `/api/dashboard/attention`
 * and the task pages cannot drift apart.
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
import { loadCritiqueScores, toScoreNumber } from './critiqueScore.js';

/** Worker lifecycle states the UI labels "Active"/"Implementing". */
export const RUNNING_TASK_STATES = ['processing', 'claude_execution', 'post_processing', 'active'] as const;

/** Worker lifecycle states the UI labels "Waiting". */
export const QUEUED_TASK_STATES = ['pending', 'queued', 'waiting'] as const;

/**
 * Explicit "a human must act" task states. These mirror the states
 * `apps/desktop/src/native-notifications.ts` already treats as attention
 * states, including both their snake_case and kebab-case spellings.
 */
export const ATTENTION_TASK_STATES = [
  'action_required', 'action-required', 'needs_attention', 'needs-attention',
] as const;

/** Terminal lifecycle states. Cancelled work is terminal but not an outcome of quality. */
export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;

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

/**
 * How far back an unresolved failure is still considered actionable, and how
 * many work rows a single dashboard read will project. Both bound the work set
 * on busy instances; neither changes how a listed item is classified.
 */
export const WORK_LOOKBACK_DAYS = 14;
export const MAX_WORK_ROWS = 2000;

/** Rolling window used by the summary strip's "completed" count. */
export const RECENT_COMPLETION_WINDOW_HOURS = 24;

const RUNNING = new Set<string>(RUNNING_TASK_STATES);
const QUEUED = new Set<string>(QUEUED_TASK_STATES);
const ATTENTION = new Set<string>(ATTENTION_TASK_STATES);

export const isRunningState = (state: string): boolean => RUNNING.has(state);
export const isQueuedState = (state: string): boolean => QUEUED.has(state);
export const isAttentionState = (state: string): boolean => ATTENTION.has(state);
export const isFailedState = (state: string): boolean => state === 'failed';
export const isCompletedState = (state: string): boolean => state === 'completed';

/** Human-readable phase for a lifecycle state. Never a synthesised percentage. */
export function phaseLabel(state: string): string | null {
  if (state === 'processing') return 'Preparing';
  if (state === 'claude_execution') return 'Implementing';
  if (state === 'post_processing') return 'Finishing up';
  if (state === 'active') return 'Running';
  if (isQueuedState(state)) return 'Waiting';
  return null;
}

export interface DashboardTaskRow {
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  taskType: string | null;
  modelName: string | null;
  title: string | null;
  state: string;
  stateTimestamp: string;
  reason: string | null;
  createdAt: string;
}

interface RawTaskRow {
  task_id: string;
  repository: string;
  issue_number: number | null;
  pr_number?: number | null;
  task_type: string | null;
  model_name: string | null;
  initial_job_data: unknown;
  final_result?: unknown;
  state: string;
  state_timestamp: string;
  reason: string | null;
  created_at: string;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function taskTitle(initialJobData: unknown): string | null {
  const jobData = parseJson(initialJobData);
  if (!jobData) return null;
  if (typeof jobData.title === 'string' && jobData.title.trim()) return jobData.title;
  const issueRef = parseJson(jobData.issueRef);
  return typeof issueRef?.title === 'string' && issueRef.title.trim() ? issueRef.title : null;
}

function taskPrNumber(row: RawTaskRow): number | null {
  if (typeof row.pr_number === 'number') return row.pr_number;
  const jobData = parseJson(row.initial_job_data);
  if (typeof jobData?.pullRequestNumber === 'number') return jobData.pullRequestNumber;
  const finalResult = parseJson(row.final_result);
  const postProcessing = parseJson(finalResult?.postProcessing);
  const pullRequest = parseJson(postProcessing?.pr);
  return typeof pullRequest?.number === 'number' ? pullRequest.number : null;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
}

function mapTaskRow(row: RawTaskRow): DashboardTaskRow {
  return {
    taskId: String(row.task_id),
    repository: String(row.repository),
    issueNumber: row.issue_number === null || row.issue_number === undefined ? null : Number(row.issue_number),
    prNumber: taskPrNumber(row),
    taskType: row.task_type ?? null,
    modelName: row.model_name ?? null,
    title: taskTitle(row.initial_job_data),
    state: String(row.state),
    stateTimestamp: toIso(row.state_timestamp),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Every task joined to its own latest history row.
 *
 * Goal tasks are excluded exactly as `getTasksFromDb` excludes them, so the
 * dashboard and the task pages count the same population.
 */
export function latestTaskStateQuery(db: Knex, repository: string): Knex.QueryBuilder {
  const query = db('tasks as t')
    .where(function (this: Knex.QueryBuilder) {
      this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
    })
    .joinRaw(`
      JOIN task_history AS h ON h.history_id = (
        SELECT latest_h.history_id
        FROM task_history AS latest_h
        WHERE latest_h.task_id = t.task_id
        ORDER BY latest_h.timestamp DESC
        LIMIT 1
      )
    `);
  if (repository && repository !== 'all') query.where('t.repository', repository);
  return query;
}

const TASK_COLUMNS = [
  't.task_id', 't.repository', 't.issue_number', 't.pr_number', 't.task_type', 't.model_name',
  't.initial_job_data', 't.final_result', 't.created_at',
  'h.state', 'h.timestamp as state_timestamp', 'h.reason',
];

/**
 * Loads the open work set plus recently terminal work.
 *
 * Non-terminal work is always loaded; completed and failed work is bounded by
 * `WORK_LOOKBACK_DAYS` because a failure older than that is history, not an
 * open blocker, and because the recent-completion count only looks back hours.
 */
export async function loadDashboardWorkRows(
  db: Knex,
  repository: string,
  options: { now?: Date; lookbackDays?: number } = {},
): Promise<DashboardTaskRow[]> {
  const now = options.now ?? new Date();
  const lookbackDays = options.lookbackDays ?? WORK_LOOKBACK_DAYS;
  const lookback = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const openStates = [...RUNNING_TASK_STATES, ...QUEUED_TASK_STATES, ...ATTENTION_TASK_STATES];

  const rows = await latestTaskStateQuery(db, repository)
    .where(function (this: Knex.QueryBuilder) {
      this.whereIn('h.state', openStates)
        .orWhere(function (this: Knex.QueryBuilder) {
          this.whereIn('h.state', ['failed', 'completed']).andWhere('h.timestamp', '>=', lookback);
        });
    })
    .select(TASK_COLUMNS)
    .orderBy('h.timestamp', 'desc')
    .limit(MAX_WORK_ROWS) as unknown as RawTaskRow[];

  return rows.map(mapTaskRow);
}

export interface PlanIssueDecisionRow {
  id: number;
  repository: string;
  issueNumber: number;
  prNumber: number | null;
  status: string;
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
  return rows.map(row => ({
    id: Number(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    status: String(row.status),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    updatedAt: toIso(row.updated_at),
  }));
}

/**
 * The thread a task belongs to. Follow-ups, retries and PR comment runs for the
 * same issue or pull request share a key, so a newer run can supersede an older
 * failure. Tasks without an issue number are their own thread.
 */
export function workKey(row: Pick<DashboardTaskRow, 'repository' | 'issueNumber' | 'taskId'>): string {
  return row.issueNumber === null ? `${row.repository}#task:${row.taskId}` : `${row.repository}#${row.issueNumber}`;
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
  rows: readonly DashboardTaskRow[],
  planIssues: readonly PlanIssueDecisionRow[],
  options: { now?: Date; recentWindowHours?: number } = {},
): DashboardWorkProjection {
  const now = options.now ?? new Date();
  const recentWindowMs = (options.recentWindowHours ?? RECENT_COMPLETION_WINDOW_HOURS) * 60 * 60 * 1000;

  const running: DashboardTaskRow[] = [];
  const queued: DashboardTaskRow[] = [];
  const recentlyCompleted: DashboardTaskRow[] = [];
  const recovering = new Set<string>();
  const completedAt = new Map<string, number>();

  for (const row of rows) {
    const key = workKey(row);
    if (isRunningState(row.state)) {
      running.push(row);
      recovering.add(key);
    } else if (isQueuedState(row.state)) {
      queued.push(row);
      recovering.add(key);
    } else if (isCompletedState(row.state)) {
      const timestamp = Date.parse(row.stateTimestamp);
      completedAt.set(key, Math.max(completedAt.get(key) ?? 0, timestamp));
      if (now.getTime() - timestamp <= recentWindowMs) recentlyCompleted.push(row);
    }
  }

  const blocked: AttentionItem[] = [];
  for (const row of rows) {
    const key = workKey(row);
    if (isAttentionState(row.state)) {
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
      continue;
    }
    if (!isFailedState(row.state)) continue;
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
    title: null,
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
    recentlyCompleted,
    counts: {
      needsAttention: attention.length,
      running: running.length,
      queued: queued.length,
      completedRecently: recentlyCompleted.length,
    },
  };
}

/** One dashboard read of every work source, already projected. */
export async function loadDashboardWork(
  db: Knex,
  repository: string,
  options: { now?: Date } = {},
): Promise<DashboardWorkProjection> {
  const [rows, planIssues] = await Promise.all([
    loadDashboardWorkRows(db, repository, options),
    loadPlanIssueDecisions(db, repository),
  ]);
  return projectDashboardWork(rows, planIssues, options);
}

export interface OutcomeRow extends DashboardTaskRow {
  planIssueStatus: string | null;
  /** Implementation critique score out of 10, or null when none was recorded. */
  score: number | null;
}

/**
 * Recent terminal task runs, newest first.
 *
 * One row per task: a task's "implementation completed" and "PR ready"
 * progress entries share a single terminal state, so they collapse into one
 * outcome. Heartbeats, indexing updates and CI job entries never reach this
 * set because only terminal task lifecycle states are read.
 */
export async function loadOutcomeRows(
  db: Knex,
  repository: string,
  options: { limit?: number; since?: Date } = {},
): Promise<OutcomeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const query = latestTaskStateQuery(db, repository)
    .whereIn('h.state', [...TERMINAL_TASK_STATES])
    .select(TASK_COLUMNS)
    .orderBy('h.timestamp', 'desc')
    .limit(limit);
  if (options.since) query.where('h.timestamp', '>=', options.since.toISOString());

  const rows = await query as unknown as RawTaskRow[];
  const mapped = rows.map(mapTaskRow);
  if (mapped.length === 0) return [];

  const taskIds = mapped.map(row => row.taskId);
  const [planRows, scores] = await Promise.all([
    db('plan_issues')
      .whereIn('task_id', taskIds)
      .whereNotNull('task_id')
      .select('task_id', 'status')
      .orderBy('id', 'asc') as unknown as Promise<Array<Record<string, unknown>>>,
    loadCritiqueScores(db, taskIds),
  ]);
  const statusByTask = new Map<string, string>();
  for (const row of planRows) statusByTask.set(String(row.task_id), String(row.status));

  return mapped.map(row => ({
    ...row,
    planIssueStatus: statusByTask.get(row.taskId) ?? null,
    score: toScoreNumber(scores.get(row.taskId)),
  }));
}

export interface PlanIssueOutcomeRow {
  id: number;
  repository: string;
  issueNumber: number;
  prNumber: number | null;
  status: string;
  taskId: string | null;
  occurredAt: string;
}

/**
 * Review results recorded against plan issues, newest first.
 *
 * A merge or a close happens after the implementation run finished, so it is a
 * separate outcome from that run's completion rather than a duplicate of it.
 */
export async function loadPlanIssueOutcomes(
  db: Knex,
  repository: string,
  options: { limit?: number } = {},
): Promise<PlanIssueOutcomeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const query = db('plan_issues')
    .whereIn('status', ['merged', 'closed'])
    .select('id', 'repository', 'issue_number', 'pr_number', 'status', 'task_id', 'updated_at')
    .orderBy('updated_at', 'desc')
    .limit(limit);
  if (repository && repository !== 'all') query.where('repository', repository);

  const rows = await query as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: Number(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    status: String(row.status),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    occurredAt: toIso(row.updated_at),
  }));
}
