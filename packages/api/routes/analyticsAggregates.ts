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
import { analyticsDayKeys, whereCreatedWithin, windowLastInstant, type AnalyticsWindow } from './analyticsWindow.js';
import { hasColumn } from './analyticsSchema.js';

export interface TaskSummary {
  /** Tasks created in the window, goal tasks aside. */
  total: number;
  /** Of those, tasks that recorded a completion. */
  completed: number;
  /** Of those, tasks that recorded a failure. */
  failed: number;
  /** Tasks created per UTC day, every day in the window listed; without a window, only days with tasks. */
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

/**
 * Task volume for a window, or for all time without one: what was submitted,
 * and how much of it finished either way. A task that failed and later
 * succeeded counts as both, as the Analytics success rate always has.
 *
 * `dailySince` bounds only the per-day grouping, for a caller that draws
 * fewer days than it totals; the totals still cover the whole window.
 */
export async function loadTaskSummary(
  db: Knex, window: AnalyticsWindow | null, repository = 'all', options: { dailySince?: Date } = {},
): Promise<TaskSummary> {
  const { dailySince } = options;
  const dailyQuery = db('tasks')
    .select(db.raw('date(created_at) as date'))
    .count('* as count')
    .groupByRaw('date(created_at)')
    .orderBy('date', 'asc');
  whereCreatedWithin(dailyQuery, 'created_at', window);
  scopeToRepository(dailyQuery, 'repository', repository);
  excludeGoalTasks(dailyQuery, 'task_type');
  if (dailySince) dailyQuery.where('created_at', '>=', dailySince.toISOString());

  // Without a bound on the days, the days themselves add up to the total.
  const totalQuery = () => {
    const query = db('tasks').count('* as count');
    whereCreatedWithin(query, 'created_at', window);
    scopeToRepository(query, 'repository', repository);
    excludeGoalTasks(query, 'task_type');
    return query.first() as unknown as Promise<{ count?: number | string } | undefined>;
  };

  const outcomeCount = (state: string) => {
    const query = db('task_history as h')
      .join('tasks as t', 't.task_id', 'h.task_id')
      .countDistinct('h.task_id as count')
      .where('h.state', state);
    whereCreatedWithin(query, 't.created_at', window);
    scopeToRepository(query, 't.repository', repository);
    excludeGoalTasks(query, 't.task_type');
    return query.first() as unknown as Promise<{ count?: number | string } | undefined>;
  };

  const [dailyRows, completed, failed, bounded] = await Promise.all([
    dailyQuery as unknown as Promise<Array<{ date: string; count: number | string }>>,
    outcomeCount('completed'),
    outcomeCount('failed'),
    dailySince ? totalQuery() : Promise.resolve(undefined),
  ]);

  const counts = new Map(dailyRows.map(row => [String(row.date), Number(row.count)]));
  const from = window?.from ?? (dailyRows.length > 0 ? new Date(`${dailyRows[0].date}T00:00:00.000Z`) : null);
  const dailyCounts = !window
    ? dailyRows.map(row => ({ date: String(row.date), count: Number(row.count) }))
    : from ? analyticsDayKeys(from, windowLastInstant(window)).map(date => ({ date, count: counts.get(date) ?? 0 })) : [];

  return {
    total: bounded ? Number(bounded.count ?? 0) : dailyRows.reduce((sum, row) => sum + Number(row.count), 0),
    completed: Number(completed?.count ?? 0),
    failed: Number(failed?.count ?? 0),
    dailyCounts,
  };
}

/**
 * The activity chart's days: tasks created and runs started on each.
 *
 * A fixed-length window lists every one of its days. All time starts at the
 * earliest day with either a task or a run — a planning run can precede the
 * first task, or exist without any — so every run the delivery band totals
 * lands on a day the chart draws.
 */
export function activityDays(
  taskDays: Array<{ date: string; count: number }>, dailyRuns: Map<string, number>, window: AnalyticsWindow,
): Array<{ date: string; count: number; runs: number }> {
  let days = taskDays;
  if (!window.from) {
    const first = [...taskDays.map(day => day.date), ...dailyRuns.keys()].sort()[0];
    const counts = new Map(taskDays.map(day => [day.date, day.count]));
    days = first ? analyticsDayKeys(new Date(`${first}T00:00:00.000Z`), windowLastInstant(window)).map(date => ({ date, count: counts.get(date) ?? 0 })) : [];
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
  /** Tasks created in the window, goal tasks aside: the totals band's "Total tasks". */
  tasks: number;
  /** `total / tasks`, the iteration multiplier. Null without any tasks. */
  per_task: number | null;
}

/**
 * Run volume: the compute behind the deliverables. A task often takes several
 * runs — implement, review, fix — so runs and tasks are reported separately.
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
  const tasksQuery = db('tasks').count('* as tasks');
  whereCreatedWithin(tasksQuery, 'created_at', window);
  excludeGoalTasks(tasksQuery, 'task_type');
  const [runs, tasks] = await Promise.all([
    runsQuery.first() as unknown as Promise<{ total?: number | string } | undefined>,
    tasksQuery.first() as unknown as Promise<{ tasks?: number | string } | undefined>,
  ]);
  const total = Number(runs?.total ?? 0);
  const taskCount = Number(tasks?.tasks ?? 0);
  return {
    total,
    tasks: taskCount,
    per_task: taskCount > 0 ? Number((total / taskCount).toFixed(2)) : null,
  };
}

/**
 * Runs started per UTC day, keyed by day; days without a run are absent.
 * `since` bounds the days for a caller that draws fewer than the window holds.
 *
 * The same executions `loadRunVolume` totals, bucketed by when each started,
 * so the activity chart's daily runs sum to the delivery band's run count.
 */
export async function loadDailyRuns(db: Knex, window: AnalyticsWindow | null, since?: Date): Promise<Map<string, number>> {
  const query = db('llm_executions')
    .select(db.raw('date(start_time) as date'))
    .count('* as runs')
    .groupByRaw('date(start_time)');
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
