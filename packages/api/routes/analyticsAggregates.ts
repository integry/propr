/**
 * The aggregations behind both the Analytics page and the dashboard's
 * historical stats widget.
 *
 * Both views used to count from their own pipelines — the widget by outcome
 * transitions over whole UTC days, the page by task creation over a rolling
 * window — so the same "7 days" showed two task counts, two spends and two
 * different curves. Every figure they share is now read here, over the same
 * `AnalyticsWindow`, so the two views can only disagree if their windows do.
 */

import type { Knex } from 'knex';
import {
  analyticsBucketKeys,
  analyticsWindowBucket,
  bucketKeySql,
  bucketStart,
  whereCreatedWithin,
  windowLastInstant,
  type AnalyticsWindow,
} from './analyticsWindow.js';
import { hasColumn } from './analyticsSchema.js';

export interface TaskSummary {
  /** Tasks worked on in the window — pull requests, as `groupTaskRuns` groups them — goal tasks aside. */
  total: number;
  /** Of those, tasks with a run that recorded a completion. */
  completed: number;
  /** Of those, tasks with a run that recorded a failure. */
  failed: number;
  /**
   * Tasks per bucket, each counted in the bucket of its first run in the
   * window, every bucket in the window listed; without a window, only days
   * with tasks. A bucket is a UTC day, keyed `YYYY-MM-DD`,
   * or for the single-day timeframe a UTC hour, keyed by the ISO instant at
   * the top of the hour (see `analyticsWindowBucket`).
   */
  dailyCounts: Array<{ date: string; count: number }>;
}

const scopeToRepository = <T extends Knex.QueryBuilder>(query: T, column: string, repository: string): T => {
  if (repository && repository !== 'all') query.where(column, repository);
  return query;
};

/**
 * Leaves goal tasks out of a task count. A goal orchestrates the tasks that do
 * its work rather than delivering any itself, and the task pages, the
 * Completed feed and the summary strip all leave it out; counting it here
 * would make the widget and the Analytics totals disagree with them. The
 * delivery band's autonomy figure leaves it out for the same reason.
 */
export const excludeGoalTasks = <T extends Knex.QueryBuilder>(query: T, column: string): T =>
  query.where(function (this: Knex.QueryBuilder) {
    this.whereNull(column).orWhereNot(column, 'goal');
  }) as T;

interface TaskRunRow {
  task_id: string;
  repository: string | null;
  issue_number: number | string | null;
  pr_number: number | string | null;
  job_pr_number?: number | string | null;
  job_issue_number?: number | string | null;
  result_pr_number?: number | string | null;
  created_at: string;
  bucket?: string | null;
}

const positiveNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

/**
 * Task rows grouped into tasks as the task list groups them
 * (`groupTasksForDisplay` in the UI): a task is a pull request with every run
 * on it — the implementation, follow-ups, reviews and merge-conflict fixes —
 * or, before a PR exists, its issue. Each row of `tasks` is one run. An
 * issue's runs join its PR once a run links the two; a row naming neither is
 * a task of its own. Rows arrive oldest first, so each group's first row is
 * the task's first run.
 */
export function groupTaskRuns<T extends TaskRunRow>(rows: T[], linkageRows: TaskRunRow[] = rows): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  const issueToPullRequest = new Map<string, string>();
  // Linkage can precede the counted runs. It establishes identity only;
  // these rows must not contribute outcomes or first-run buckets.
  for (const row of linkageRows) {
    const repository = row.repository || 'unknown/unknown';
    const prNumber = positiveNumber(row.pr_number) ?? positiveNumber(row.job_pr_number) ?? positiveNumber(row.result_pr_number);
    const linkedIssue = positiveNumber(row.job_issue_number);
    if (prNumber && linkedIssue) issueToPullRequest.set(`${repository}-issue-${linkedIssue}`, `${repository}-pr-${prNumber}`);
  }
  for (const row of rows) {
    const repository = row.repository || 'unknown/unknown';
    const prNumber = positiveNumber(row.pr_number) ?? positiveNumber(row.job_pr_number) ?? positiveNumber(row.result_pr_number);
    const issueNumber = positiveNumber(row.issue_number);
    const issueKey = `${repository}-issue-${issueNumber}`;
    const key = prNumber ? `${repository}-pr-${prNumber}`
      : issueNumber ? issueToPullRequest.get(issueKey) ?? issueKey
      : row.task_id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/** Counted runs and their linkage metadata, goal tasks aside, oldest first. */
async function loadTaskRuns(
  db: Knex, window: AnalyticsWindow | null, repository: string, bucketKey?: string,
): Promise<{ runs: TaskRunRow[]; linkageRows: TaskRunRow[] }> {
  const [hasJobData, hasFinalResult] = await Promise.all([
    hasColumn(db, 'tasks', 'initial_job_data'),
    hasColumn(db, 'tasks', 'final_result'),
  ]);
  const json = (column: string, path: string, alias: string) =>
    db.raw(`CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END AS ${alias}`);
  const query = db('tasks')
    .select('task_id', 'repository', 'issue_number', 'pr_number', 'created_at')
    .orderBy('created_at', 'asc');
  if (hasJobData) query.select(json('initial_job_data', '$.pullRequestNumber', 'job_pr_number'), json('initial_job_data', '$.issueNumber', 'job_issue_number'));
  if (hasFinalResult) query.select(json('final_result', '$.postProcessing.pr.number', 'result_pr_number'));
  scopeToRepository(query, 'repository', repository);
  excludeGoalTasks(query, 'task_type');
  // Only older rows can supply omitted links. Preserve the repository and
  // goal scope, and keep newer rows beyond the window's upper bound out.
  const earlierLinks = window?.from && hasJobData
    ? query.clone().where('created_at', '<', window.from.toISOString())
      .whereRaw("CASE WHEN json_valid(initial_job_data) THEN json_extract(initial_job_data, '$.issueNumber') END IS NOT NULL")
    : Promise.resolve([]);
  if (bucketKey) query.select(db.raw(`${bucketKey} as bucket`));
  whereCreatedWithin(query, 'created_at', window);
  const [runs, links] = await Promise.all([query, earlierLinks]) as [TaskRunRow[], TaskRunRow[]];
  return { runs, linkageRows: [...links, ...runs] };
}

/**
 * Task volume for a window, or for all time without one: how many tasks were
 * worked on, and how many of them finished either way. A task with a failed
 * run and a later successful one counts as both, as the Analytics success
 * rate always has.
 *
 * `dailySince` bounds only the per-day grouping, for a caller that draws
 * fewer days than it totals; the totals still cover the whole window.
 */
export async function loadTaskSummary(
  db: Knex, window: AnalyticsWindow | null, repository = 'all', options: { dailySince?: Date } = {},
): Promise<TaskSummary> {
  const { dailySince } = options;
  const bucket = analyticsWindowBucket(window);
  const bucketKey = bucketKeySql('created_at', bucket);

  const outcomesQuery = db('task_history as h')
    .join('tasks as t', 't.task_id', 'h.task_id')
    .distinct('h.task_id', 'h.state')
    .whereIn('h.state', ['completed', 'failed']);
  whereCreatedWithin(outcomesQuery, 't.created_at', window);
  scopeToRepository(outcomesQuery, 't.repository', repository);
  excludeGoalTasks(outcomesQuery, 't.task_type');

  const [{ runs, linkageRows }, outcomes] = await Promise.all([
    loadTaskRuns(db, window, repository, bucketKey),
    outcomesQuery as unknown as Promise<Array<{ task_id: string; state: string }>>,
  ]);
  const runsWith = (state: string) => new Set(outcomes.filter(row => row.state === state).map(row => String(row.task_id)));
  const [completedRuns, failedRuns] = [runsWith('completed'), runsWith('failed')];

  // Each task counts once, in the bucket of its first run in the window.
  const since = dailySince?.toISOString();
  const counts = new Map<string, number>();
  const tasks = [...groupTaskRuns(runs, linkageRows).values()];
  const countTasks = (runIds: Set<string>) => tasks.filter(task => task.some(run => runIds.has(String(run.task_id)))).length;
  for (const [first] of tasks) {
    if (!first.bucket || (since && String(first.created_at) < since)) continue;
    counts.set(first.bucket, (counts.get(first.bucket) ?? 0) + 1);
  }
  const dailyRows = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([date, count]) => ({ date, count }));
  const from = window?.from ?? (dailyRows.length > 0 ? bucketStart(String(dailyRows[0].date)) : null);
  const dailyCounts = !window
    ? dailyRows.map(row => ({ date: String(row.date), count: Number(row.count) }))
    : from ? analyticsBucketKeys(from, windowLastInstant(window), bucket).map(date => ({ date, count: counts.get(date) ?? 0 })) : [];

  return {
    total: tasks.length,
    completed: countTasks(completedRuns),
    failed: countTasks(failedRuns),
    dailyCounts,
  };
}

/**
 * The activity chart's buckets: tasks created and runs started in each. A
 * bucket is a UTC day, or a UTC hour over the single-day timeframe.
 *
 * A fixed-length window lists every one of its buckets. All time starts at
 * the earliest day with either a task or a run — a planning run can precede
 * the first task, or exist without any — so every run the delivery band
 * totals lands on a day the chart draws.
 */
export function activityDays(
  taskDays: Array<{ date: string; count: number }>, dailyRuns: Map<string, number>, window: AnalyticsWindow,
): Array<{ date: string; count: number; runs: number }> {
  let days = taskDays;
  if (!window.from) {
    const first = [...taskDays.map(day => day.date), ...dailyRuns.keys()].sort()[0];
    const counts = new Map(taskDays.map(day => [day.date, day.count]));
    days = first
      ? analyticsBucketKeys(bucketStart(first), windowLastInstant(window), analyticsWindowBucket(window)).map(date => ({ date, count: counts.get(date) ?? 0 }))
      : [];
  }
  return days.map(day => ({ date: day.date, count: day.count, runs: dailyRuns.get(day.date) ?? 0 }));
}

/**
 * Spend recorded against executions started in the window.
 *
 * Null when no execution recorded a cost at all: an instance that never
 * records cost has not spent $0.
 */
export async function loadRecordedSpend(
  db: Knex, window: AnalyticsWindow | null, repository = 'all',
): Promise<number | null> {
  const query = db('llm_executions as e').whereNotNull('e.cost_usd');
  whereCreatedWithin(query, 'e.start_time', window);
  if (repository && repository !== 'all') {
    query.join('tasks as t', 't.task_id', 'e.task_id').where('t.repository', repository);
  }
  const row = await query
    .sum({ cost: 'e.cost_usd' })
    .count({ recorded: 'e.cost_usd' })
    .first() as { cost?: number | string | null; recorded?: number | string | null } | undefined;
  if (!row || Number(row.recorded ?? 0) === 0) return null;
  return Number(Number(row.cost ?? 0).toFixed(4));
}

export interface RunVolume {
  /**
   * Agent executions started in the window: the sum of the Models table's
   * runs, its unknown-model row included.
   */
  total: number;
  /** Tasks worked on in the window, goal tasks aside: the totals band's "Total tasks". */
  tasks: number;
  /** `total / tasks`, the iteration multiplier. Null without any tasks. */
  per_task: number | null;
}

/**
 * Run volume: the compute behind the deliverables. A task is a pull request
 * (see `groupTaskRuns`) and takes several runs — implement, review, fix,
 * resolve a conflict — so runs and tasks are reported separately.
 *
 * The multiplier divides the two figures the page prints beside it — total
 * runs, as the Models table sums them, by total tasks, as the totals band
 * counts them — so `tasks × per_task = total` holds on screen. Dividing by
 * only the tasks that recorded a run would leave tasks with no recorded run
 * (queued, cancelled, or on an agent that reports none) out of one figure and
 * in the other.
 */
export async function loadRunVolume(db: Knex, window: AnalyticsWindow | null): Promise<RunVolume> {
  const runsQuery = db('llm_executions').count('* as total');
  whereCreatedWithin(runsQuery, 'start_time', window);
  const [runs, { runs: taskRuns, linkageRows }] = await Promise.all([
    runsQuery.first() as unknown as Promise<{ total?: number | string } | undefined>,
    loadTaskRuns(db, window, 'all'),
  ]);
  const total = Number(runs?.total ?? 0);
  const taskCount = groupTaskRuns(taskRuns, linkageRows).size;
  return {
    total,
    tasks: taskCount,
    per_task: taskCount > 0 ? Number((total / taskCount).toFixed(2)) : null,
  };
}

/**
 * Runs started per bucket, keyed as `loadTaskSummary` keys its buckets;
 * buckets without a run are absent. `since` bounds the days for a caller
 * that draws fewer than the window holds.
 *
 * The same executions `loadRunVolume` totals, bucketed by when each started,
 * so the activity chart's runs sum to the delivery band's run count.
 */
export async function loadDailyRuns(db: Knex, window: AnalyticsWindow | null, since?: Date): Promise<Map<string, number>> {
  const bucketKey = bucketKeySql('start_time', analyticsWindowBucket(window));
  const query = db('llm_executions')
    .select(db.raw(`${bucketKey} as date`))
    .count('* as runs')
    .groupByRaw(bucketKey);
  whereCreatedWithin(query, 'start_time', window);
  if (since) query.where('start_time', '>=', since.toISOString());
  const rows = await query as unknown as Array<{ date: string | null; runs: number | string }>;
  return new Map(rows.filter(row => row.date).map(row => [String(row.date), Number(row.runs)]));
}

/** Prompt and cache-read prices per token for a recorded model name, or null when unknown. */
export type CachePriceLookup = (model: string) => { prompt: number; cacheRead?: number } | null;

export interface CacheUsage {
  /**
   * Prompt tokens across executions that reported a cache breakdown: the
   * whole prompt, cache writes and cache reads included.
   */
  input_tokens: number;
  /** Of those, tokens served from the prompt cache. */
  cache_read_tokens: number;
  /** Share of prompt tokens served from the cache, 0–1. */
  hit_rate: number;
  /**
   * What those cached reads would have cost at the full prompt price, less
   * what they did cost. Null when no model behind them has a known price.
   */
  saved_usd: number | null;
}

/**
 * Prompt cache effectiveness. Null when no execution in the window reported
 * a cache breakdown, so an agent that never reports one does not read as a
 * 0% hit rate.
 *
 * Executions persist `input_tokens` as the whole prompt: `recordLLMMetrics`
 * stores the sum of uncached input, cache writes and cache reads there, beside
 * the separate cache-write and cache-read counts (an agent that reports an
 * inclusive count, as Codex does, is split into those parts first, then summed
 * back). The persisted input is therefore the denominator as it is; adding the
 * cache counts to it again would count every cached token twice and halve the
 * hit rate of a well-cached run.
 *
 * Only executions with a known breakdown enter the denominator. The producer
 * now persists null cache counts and `cache_usage_reported = false` for an
 * agent that reported none, and `true` beside the counts it did report, zero
 * included. Rows from before that column stored a zero for missing telemetry
 * too, so without the flag a row counts only if it shows some cache activity:
 * a historical zero is unknown, not a measured 0%, and must not dilute the rate.
 */
export async function loadCacheUsage(
  db: Knex, window: AnalyticsWindow | null, priceOf: CachePriceLookup,
): Promise<CacheUsage | null> {
  const [hasInput, hasCacheRead, hasReported] = await Promise.all([
    hasColumn(db, 'llm_executions', 'input_tokens'),
    hasColumn(db, 'llm_executions', 'cache_read_input_tokens'),
    hasColumn(db, 'llm_executions', 'cache_usage_reported'),
  ]);
  if (!hasInput || !hasCacheRead) return null;

  const query = db('llm_executions')
    .select('model_name')
    .sum({ input: 'input_tokens', cached: 'cache_read_input_tokens' })
    .whereNotNull('cache_read_input_tokens')
    .whereNotNull('input_tokens')
    .where(known => {
      known.where('cache_read_input_tokens', '>', 0).orWhere('cache_creation_input_tokens', '>', 0);
      if (hasReported) known.orWhere('cache_usage_reported', true);
    })
    .groupBy('model_name');
  whereCreatedWithin(query, 'start_time', window);
  const rows = await query as unknown as Array<{
    model_name: string | null; input: number | string | null; cached: number | string | null;
  }>;

  let prompt = 0;
  let cached = 0;
  let saved = 0;
  let priced = false;
  for (const row of rows) {
    const rowCached = Number(row.cached ?? 0);
    // A prompt holds at least the tokens read back from the cache: a row that
    // somehow stored fewer cannot push the hit rate past 100%.
    prompt += Math.max(Number(row.input ?? 0), rowCached);
    cached += rowCached;
    const price = row.model_name ? priceOf(row.model_name) : null;
    if (price && price.cacheRead !== undefined && rowCached > 0) {
      saved += rowCached * Math.max(0, price.prompt - price.cacheRead);
      priced = true;
    }
  }
  if (prompt <= 0) return null;
  return {
    input_tokens: prompt,
    cache_read_tokens: cached,
    hit_rate: Number((cached / prompt).toFixed(4)),
    saved_usd: priced ? Number(saved.toFixed(2)) : null,
  };
}
