/**
 * Shared dashboard task-row primitives.
 *
 * The dashboard answers four questions from three sources of truth: task state
 * (running, queued, blocked), outcome events (recent history) and aggregated
 * execution data (stats). Each source has its own module —
 * `dashboardWorkQueries.ts`, `dashboardOutcomeQueries.ts` and
 * `dashboardStatsQueries.ts` — and all three read task rows through the
 * lifecycle states, column list and row mapping defined here, so
 * `/api/dashboard/summary`, `/api/dashboard/active`, `/api/dashboard/attention`
 * and the task pages cannot drift apart.
 *
 * Attention is derived from work state only. Notification read/dismissal state
 * lives in `notification_user_states` and is deliberately never read here:
 * dismissing a notification must not resolve a blocker.
 */

import type { Knex } from 'knex';

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
 * How far back an unresolved failure is still considered actionable, and how
 * many *finished* rows a single dashboard read will project.
 *
 * `MAX_WORK_ROWS` bounds recent completions only. Open work — running, queued
 * and action-required tasks — and the unresolved failures behind the attention
 * count are never truncated by it: a display limit that drops a running task
 * would make the running count claim that work does not exist.
 */
export const WORK_LOOKBACK_DAYS = 14;
export const MAX_WORK_ROWS = 2000;

/** Bound on one `IN (...)` list, so a large failure set cannot overflow a bind limit. */
const ID_CHUNK_SIZE = 500;

export function chunk<T>(values: readonly T[], size: number = ID_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

/** Rolling window used by the summary strip's "completed" count. */
export const RECENT_COMPLETION_WINDOW_HOURS = 24;

const RUNNING = new Set<string>(RUNNING_TASK_STATES);
const QUEUED = new Set<string>(QUEUED_TASK_STATES);
const ATTENTION = new Set<string>(ATTENTION_TASK_STATES);

export const isRunningState = (state: string): boolean => RUNNING.has(state);
export const isQueuedState = (state: string): boolean => QUEUED.has(state);
export const isAttentionState = (state: string): boolean => ATTENTION.has(state);

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

/** The database shape every dashboard source selects via `TASK_COLUMNS`. */
export interface RawTaskRow {
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

/**
 * What a run is about, from the job data it was queued with.
 *
 * The recorded title first, then the linked issue's title, then the branch the
 * run works on. A branch is a weak title but a real one: `feature/icon-cache`
 * tells a reviewer what they are about to open, where the fallback the UI is
 * otherwise left with — `Pull request #2482` under a `PR #2482` chip — only
 * repeats the identifier already on the row.
 */
export function taskTitle(initialJobData: unknown): string | null {
  const jobData = parseJson(initialJobData);
  if (!jobData) return null;
  if (typeof jobData.title === 'string' && jobData.title.trim()) return jobData.title;
  const issueRef = parseJson(jobData.issueRef);
  if (typeof issueRef?.title === 'string' && issueRef.title.trim()) return issueRef.title;
  return typeof jobData.branchName === 'string' && jobData.branchName.trim() ? jobData.branchName : null;
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

export function mapTaskRow(row: RawTaskRow): DashboardTaskRow {
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

export const TASK_COLUMNS = [
  't.task_id', 't.repository', 't.issue_number', 't.pr_number', 't.task_type', 't.model_name',
  't.initial_job_data', 't.final_result', 't.created_at',
  'h.state', 'h.timestamp as state_timestamp', 'h.reason',
];

/**
 * The thread a task belongs to. Follow-ups, retries and PR comment runs for the
 * same issue or pull request share a key, so a newer run can supersede an older
 * failure. Tasks without an issue number are their own thread.
 */
export function workKey(row: Pick<DashboardTaskRow, 'repository' | 'issueNumber' | 'taskId'>): string {
  return row.issueNumber === null ? `${row.repository}#task:${row.taskId}` : `${row.repository}#${row.issueNumber}`;
}

/** The run behind a plan issue: its task identity and what it was about. */
export interface ThreadWork {
  taskId: string;
  title: string | null;
}

/** Thread lookups for a set of issues: by thread key, and by task id. */
export interface ThreadWorkIndex {
  byThread: Map<string, ThreadWork>;
  titleByTaskId: Map<string, string | null>;
}

/**
 * The runs behind a set of issue threads.
 *
 * A `plan_issues` row has no title column and, in older rows, no task link
 * either, so everything a review row or a merge row can say about itself comes
 * from the tasks on its thread. Reading them once gives both: the task a plan
 * issue should point at, and the title the rest of the dashboard already shows
 * for that work — which is what keeps a row from falling back to printing the
 * entity number it already carries as a chip.
 */
export async function loadThreadWork(
  db: Knex,
  repository: string,
  issueNumbers: readonly number[],
): Promise<ThreadWorkIndex> {
  const index: ThreadWorkIndex = { byThread: new Map(), titleByTaskId: new Map() };
  const unique = [...new Set(issueNumbers)];
  if (unique.length === 0) return index;

  for (const batch of chunk(unique)) {
    const query = db('tasks as t')
      .where(function (this: Knex.QueryBuilder) {
        this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
      })
      .whereIn('t.issue_number', batch)
      .select('t.task_id', 't.repository', 't.issue_number', 't.initial_job_data')
      // Ascending, so the last write for a thread is its newest run.
      .orderBy('t.created_at', 'asc');
    if (repository && repository !== 'all') query.where('t.repository', repository);
    for (const row of await query as Array<Record<string, unknown>>) {
      const work: ThreadWork = { taskId: String(row.task_id), title: taskTitle(row.initial_job_data) };
      index.byThread.set(`${String(row.repository)}#${Number(row.issue_number)}`, work);
      index.titleByTaskId.set(work.taskId, work.title);
    }
  }
  return index;
}

/**
 * The title a plan issue inherits: its own run's, else its thread's newest.
 */
export function threadTitle(
  index: ThreadWorkIndex,
  row: { repository: string; issueNumber: number; taskId: string | null },
): string | null {
  const own = row.taskId === null ? null : index.titleByTaskId.get(row.taskId) ?? null;
  return own ?? index.byThread.get(`${row.repository}#${row.issueNumber}`)?.title ?? null;
}

/**
 * Tasks joined to their latest recorded transition into one terminal state.
 *
 * Outcomes are recorded events, so they are read from history rather than from
 * a task's current state: a run that failed and is now being retried still
 * failed, and dropping that record would rewrite both the feed and the success
 * rate the moment the retry starts.
 *
 * One row per task per state is the deduplication: a task's "implementation
 * completed" and "PR ready" entries share a terminal state and collapse into
 * the single outcome they describe, while a task that failed and later
 * completed keeps both of its outcomes. Confining the lookup to the window
 * keeps an event that happened inside it from being displaced by a later one
 * outside it. Heartbeats, indexing updates and CI entries never reach this set
 * because only terminal task lifecycle states are read.
 */
export function terminalTransitionQuery(
  db: Knex,
  repository: string,
  state: string,
  window: { from?: Date; to?: Date } = {},
): Knex.QueryBuilder {
  const bindings: unknown[] = [state];
  let windowSql = '';
  if (window.from) {
    windowSql += ' AND lh.timestamp >= ?';
    bindings.push(window.from.toISOString());
  }
  if (window.to) {
    windowSql += ' AND lh.timestamp < ?';
    bindings.push(window.to.toISOString());
  }

  const query = db('tasks as t')
    .where(function (this: Knex.QueryBuilder) {
      this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
    })
    .joinRaw(`
      JOIN task_history AS h ON h.history_id = (
        SELECT lh.history_id
        FROM task_history AS lh
        WHERE lh.task_id = t.task_id AND lh.state = ?${windowSql}
        ORDER BY lh.timestamp DESC
        LIMIT 1
      )
    `, bindings);
  if (repository && repository !== 'all') query.where('t.repository', repository);
  return query;
}
