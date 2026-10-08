import { Request, Response } from 'express';
import { Knex } from 'knex';
import { analyticsTimeframeStart } from '@propr/shared';
import { timeApiStage } from '../apiPerformanceTiming.js';
import { validateEnum, validateRepositoryFilter } from './validation.js';
import { successRate as calculateSuccessRate } from './dashboardStatsQueries.js';
import { readAnalyticsWindow, whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { loadModelUsage } from './analyticsModelUsage.js';
import {
  loadCacheUsage,
  loadRecordedSpend,
  loadRunVolume,
  loadDailyRuns,
  loadTaskSummary,
  activityDays,
  type CachePriceLookup,
} from './analyticsAggregates.js';
import { loadAutonomy, loadDeliveryMetrics } from './analyticsDelivery.js';
import { createAnalyticsCache, type AnalyticsCache } from './analyticsCache.js';

/** Periods the dashboard's historical stats section can request. */
export const DASHBOARD_STATS_PERIODS = ['7d', '30d'] as const;
export type DashboardStatsPeriod = typeof DASHBOARD_STATS_PERIODS[number];

interface StatsRoutesDeps {
  db: Knex;
  /** Seam for tests that need a fixed window. */
  now?: () => Date;
  /**
   * Prompt and cache-read prices per recorded model name, for the cache
   * savings estimate. Without one, savings are reported as unknown.
   */
  cachePrice?: CachePriceLookup;
  /**
   * Remembers the all-time delivery and review-quality aggregations for a
   * short while; shared with the review score routes so both read one copy.
   */
  analyticsCache?: AnalyticsCache;
}

interface DailyCountRow {
  date: string;
  count: number;
}

interface StatusDistributionRow {
  state: string;
  count: number;
}

interface AvgProcessingTimeRow {
  date: string;
  avg_minutes: number | null;
}

interface CountRow {
  total?: number;
  count?: number;
}

interface OverviewTaskStats {
  completed: number | string;
  planned: number | string;
}

interface UsageAggregation {
  inputTokens: number | string | null;
  outputTokens: number | string | null;
}

interface ModelCountRow {
  model_name: string | null;
  count: number | string;
}

interface PrIterationRow {
  issue_number: number;
  task_count: number | string;
}

interface RepositoryStatsRow {
  repository: string;
  total: number;
  completed: number;
  failed: number;
  in_progress: number;
}

/**
 * The days on which anything happened, in order: those with a task created
 * and those with only a run started, which the task grouping alone omits.
 */
function recordedActivityDays(
  taskDays: DailyCountRow[], dailyRuns: Map<string, number>,
): Array<DailyCountRow & { runs: number }> {
  const tasks = new Map(taskDays.map(day => [day.date, day.count]));
  return [...new Set([...tasks.keys(), ...dailyRuns.keys()])].sort()
    .map(date => ({ date, count: tasks.get(date) ?? 0, runs: dailyRuns.get(date) ?? 0 }));
}

export function createStatsRoutes(deps: StatsRoutesDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const cachePrice: CachePriceLookup = deps.cachePrice ?? (() => null);
  const aggregationCache = deps.analyticsCache ?? createAnalyticsCache();

  async function getTaskStats(req: Request, res: Response): Promise<void> {
    const analyticsWindow = readAnalyticsWindow(req, res, now());
    if (analyticsWindow === false) return;

    try {
      // Without a period: task counts by day for the last 30 days
      const thirtyDaysAgo = new Date(now().getTime());
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString();

      // Volume comes from the aggregation the dashboard widget shares. With a
      // period every bucket in the window is listed, including empty ones:
      // a day each, or an hour each over the last 24 hours; without one,
      // totals are all-time and the days are the last 30, so only those 30
      // are grouped, listing just the days with a task or a run.
      // Runs beside tasks, per bucket: the compute behind each one's deliverables.
      const dailySince = analyticsWindow ? undefined : thirtyDaysAgo;
      const [summary, dailyRuns] = await Promise.all([
        loadTaskSummary(db, analyticsWindow, 'all', { dailySince }),
        loadDailyRuns(db, analyticsWindow, dailySince),
      ]);
      const dailyCounts: Array<DailyCountRow & { runs: number }> = analyticsWindow
        ? activityDays(summary.dailyCounts, dailyRuns, analyticsWindow)
        : recordedActivityDays(summary.dailyCounts, dailyRuns);

      // Status distribution from latest task_history entries
      const statusDistributionQuery = db('task_history as h')
        .join(
          db('task_history')
            .select('task_id')
            .max('timestamp as max_ts')
            .groupBy('task_id')
            .as('latest'),
          function(this: Knex.JoinClause) {
            this.on('h.task_id', '=', 'latest.task_id')
                .andOn('h.timestamp', '=', 'latest.max_ts');
          }
        )
        .select('h.state')
        .count('* as count')
        .groupBy('h.state');
      if (analyticsWindow) {
        statusDistributionQuery.join('tasks as t', 't.task_id', 'h.task_id');
        whereCreatedWithin(statusDistributionQuery, 't.created_at', analyticsWindow);
      }
      const statusDistribution = await statusDistributionQuery as unknown as StatusDistributionRow[];

      // Average processing time by day (for completed tasks)
      const avgProcessingTimeQuery = db('tasks as t')
        .join('task_history as h_start', function(this: Knex.JoinClause) {
          this.on('t.task_id', '=', 'h_start.task_id')
              .andOnIn('h_start.state', ['processing', 'claude_execution']);
        })
        .join('task_history as h_end', function(this: Knex.JoinClause) {
          this.on('t.task_id', '=', 'h_end.task_id')
              .andOnIn('h_end.state', ['completed', 'failed']);
        })
        .select(
          db.raw("date(t.created_at) as date"),
          db.raw("avg((julianday(h_end.timestamp) - julianday(h_start.timestamp)) * 24 * 60) as avg_minutes")
        );
      if (analyticsWindow) {
        whereCreatedWithin(avgProcessingTimeQuery, 't.created_at', analyticsWindow);
      } else {
        avgProcessingTimeQuery.where('t.created_at', '>=', thirtyDaysAgoStr);
      }
      const avgProcessingTime = await avgProcessingTimeQuery
        .groupByRaw('date(t.created_at)')
        .orderBy('date', 'asc') as unknown as AvgProcessingTimeRow[];

      res.json({
        dailyCounts: dailyCounts.map((row) => ({
          date: String(row.date),
          count: Number(row.count),
          runs: row.runs,
        })),
        statusDistribution: statusDistribution.map((row) => ({
          status: String(row.state),
          count: Number(row.count)
        })),
        avgProcessingTime: avgProcessingTime.map((row) => ({
          date: String(row.date),
          avgMinutes: row.avg_minutes ? Number(Number(row.avg_minutes).toFixed(2)) : 0
        })),
        summary: { total: summary.total, completed: summary.completed, failed: summary.failed }
      });
    } catch (error) {
      console.error('Error in /api/stats/tasks:', error);
      res.status(500).json({ error: 'Failed to fetch task statistics' });
    }
  }

  async function getRepositoryStats(req: Request, res: Response): Promise<void> {
    const analyticsWindow = readAnalyticsWindow(req, res, now());
    if (analyticsWindow === false) return;

    try {
      // Get task counts and success rates per repository
      const repoStatsQuery = db('tasks as t')
        .leftJoin(
          db('task_history')
            .select('task_id')
            .max('timestamp as max_ts')
            .groupBy('task_id')
            .as('latest'),
          't.task_id', 'latest.task_id'
        )
        .leftJoin('task_history as h', function(this: Knex.JoinClause) {
          this.on('t.task_id', '=', 'h.task_id')
              .andOn('h.timestamp', '=', 'latest.max_ts');
        })
        .select(
          't.repository',
          db.raw('count(*) as total'),
          db.raw("sum(CASE WHEN h.state = 'completed' THEN 1 ELSE 0 END) as completed"),
          db.raw("sum(CASE WHEN h.state = 'failed' THEN 1 ELSE 0 END) as failed"),
          db.raw("sum(CASE WHEN h.state NOT IN ('completed', 'failed') THEN 1 ELSE 0 END) as in_progress")
        )
        .groupBy('t.repository')
        .orderBy('total', 'desc')
        .limit(20);
      whereCreatedWithin(repoStatsQuery, 't.created_at', analyticsWindow);
      const repoStats = await repoStatsQuery as unknown as RepositoryStatsRow[];

      // Calculate success rates and format response
      const repositories = repoStats.map((row) => {
        const total = Number(row.total);
        const completed = Number(row.completed || 0);
        const failed = Number(row.failed || 0);
        const inProgress = Number(row.in_progress || 0);
        const successRate = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0';

        return {
          repository: row.repository,
          total,
          completed,
          failed,
          inProgress,
          successRate: parseFloat(successRate)
        };
      });

      res.json({ repositories });
    } catch (error) {
      console.error('Error in /api/stats/repositories:', error);
      res.status(500).json({ error: 'Failed to fetch repository statistics' });
    }
  }

  /** Token, cost and model usage; a period bounds it by when each execution started. */
  async function loadOverviewUsage(analyticsWindow: AnalyticsWindow | null) {
    // Token & Cost Usage from llm_execution_details and llm_executions
    const usageStatsQuery = db('llm_execution_details as d')
      .sum({
        inputTokens: 'd.token_count_input',
        outputTokens: 'd.token_count_output'
      });
    if (analyticsWindow) {
      usageStatsQuery.join('llm_executions as e', 'e.execution_id', 'd.execution_id');
      whereCreatedWithin(usageStatsQuery, 'e.start_time', analyticsWindow);
    }
    const usageStats = await usageStatsQuery.first() as unknown as UsageAggregation | undefined;

    // The same recorded spend the dashboard widget reports
    const recordedSpend = await loadRecordedSpend(db, analyticsWindow);

    // Model Distribution - count unique tasks per model from llm_executions.
    // This is the legacy `usage.models` figure: distinct tasks, not runs.
    // `model_usage` (loadModelUsage) carries runs per model, and the Models
    // table only falls back to this one when a server predates it; the two
    // are kept apart so older clients keep reading the figure they expect.
    const modelStatsQuery = db('llm_executions')
      .select('model_name')
      .countDistinct('task_id as count')
      .whereNotNull('model_name')
      .groupBy('model_name')
      .orderBy('count', 'desc');
    whereCreatedWithin(modelStatsQuery, 'start_time', analyticsWindow);
    const modelStats = await modelStatsQuery as unknown as ModelCountRow[];

    // Format model stats as object
    const modelDistribution: Record<string, number> = {};
    for (const row of modelStats) {
      if (row.model_name) {
        modelDistribution[row.model_name] = Number(row.count);
      }
    }

    const inputTokens = Number(usageStats?.inputTokens || 0);
    const outputTokens = Number(usageStats?.outputTokens || 0);
    const totalCost = recordedSpend ?? 0;
    return {
      total_tokens: inputTokens + outputTokens,
      input_tokens: inputTokens, output_tokens: outputTokens,
      total_cost_usd: Number(totalCost.toFixed(2)),
      models: modelDistribution
    };
  }

  async function getOverview(req: Request, res: Response): Promise<void> {
    const analyticsWindow = readAnalyticsWindow(req, res, now());
    if (analyticsWindow === false) return;

    try {
      // 1. Task Stats - count completed tasks (latest state = completed)
      // Using subquery to get the latest state for each task
      const taskStatsQuery = db('task_history as h')
        .join(
          db('task_history')
            .select('task_id')
            .max('timestamp as max_ts')
            .groupBy('task_id')
            .as('latest'),
          function(this: Knex.JoinClause) {
            this.on('h.task_id', '=', 'latest.task_id')
                .andOn('h.timestamp', '=', 'latest.max_ts');
          }
        )
        .select(
          db.raw("SUM(CASE WHEN h.state = 'completed' THEN 1 ELSE 0 END) as completed"),
          db.raw("SUM(CASE WHEN h.state = 'pending' THEN 1 ELSE 0 END) as planned")
        );
      if (analyticsWindow) {
        taskStatsQuery.join('tasks as t', 't.task_id', 'h.task_id');
        whereCreatedWithin(taskStatsQuery, 't.created_at', analyticsWindow);
      }
      const taskStats = await taskStatsQuery.first() as unknown as OverviewTaskStats | undefined;

      // 2-3. Token, cost and model usage
      const usage = await loadOverviewUsage(analyticsWindow);
      const modelUsage = await loadModelUsage(db, analyticsWindow, aggregationCache);

      // Run volume, prompt caching, delivery and autonomy. Delivery and
      // autonomy read PR and task history, so they are remembered briefly
      // between the page's refreshes; see `analyticsCache`.
      const [runs, cache, delivery, autonomy] = await Promise.all([
        loadRunVolume(db, analyticsWindow),
        loadCacheUsage(db, analyticsWindow, cachePrice),
        aggregationCache.remember('delivery', analyticsWindow, () => loadDeliveryMetrics(db, analyticsWindow)),
        aggregationCache.remember('autonomy', analyticsWindow, () => loadAutonomy(db, analyticsWindow)),
      ]);

      // 4. PR Iterations Average - count tasks per unique issue
      const allIssueIterationsQuery = db('tasks')
        .select('repository', 'issue_number')
        .count('* as task_count')
        .whereNotNull('issue_number')
        .groupBy('repository', 'issue_number');
      whereCreatedWithin(allIssueIterationsQuery, 'created_at', analyticsWindow);
      const allIssueIterations = await allIssueIterationsQuery as unknown as PrIterationRow[];

      // Calculate average iterations across ALL issues
      let prIterationsAvg = 0;
      let totalFollowups = 0;
      if (allIssueIterations.length > 0) {
        const totalTasks = allIssueIterations.reduce((sum, row) => sum + Number(row.task_count), 0);
        const uniqueIssues = allIssueIterations.length;
        prIterationsAvg = Number((totalTasks / uniqueIssues).toFixed(1));
        // Total follow-ups = total tasks minus one initial task per issue
        totalFollowups = totalTasks - uniqueIssues;
      }

      // Count PRs created (completed tasks result in PRs being created)
      const prsCreatedQuery = db('tasks as t')
        .join(
          db('task_history')
            .select('task_id')
            .max('timestamp as max_ts')
            .groupBy('task_id')
            .as('latest'),
          't.task_id', 'latest.task_id'
        )
        .join('task_history as h', function(this: Knex.JoinClause) {
          this.on('t.task_id', '=', 'h.task_id')
              .andOn('h.timestamp', '=', 'latest.max_ts');
        })
        .countDistinct('t.issue_number as count')
        .where('h.state', 'completed');
      whereCreatedWithin(prsCreatedQuery, 't.created_at', analyticsWindow);
      const prsCreated = await prsCreatedQuery.first() as unknown as CountRow | undefined;

      // 5. Repos Indexed - count repositories with last_indexed_at not null.
      // A point-in-time fact, so a period never narrows it.
      const repoStats = await db('repositories')
        .count('* as count')
        .whereNotNull('last_indexed_at')
        .first() as unknown as CountRow | undefined;

      res.json({
        tasks: {
          completed: Number(taskStats?.completed || 0),
          planned: Number(taskStats?.planned || 0),
          pr_iterations_avg: prIterationsAvg,
          merged_prs: Number(prsCreated?.count || 0),
          total_followups: totalFollowups
        },
        usage: { ...usage, cache },
        model_usage: modelUsage,
        runs,
        delivery,
        autonomy,
        system: {
          repos_indexed: Number(repoStats?.count || 0)
        }
      });
    } catch (error) {
      console.error('Error in /api/stats/overview:', error);
      res.status(500).json({ error: 'Failed to fetch overview statistics' });
    }
  }

  /**
   * Period-aware historical stats for the dashboard.
   *
   * The widget is a summary of the Analytics page, so it reads the same
   * aggregation over the same rolling window the page uses for the same
   * period: its task count, success rate, spend and daily curve always match
   * the page's totals band and activity chart.
   *
   * Every scalar is nullable: unavailable data is null, never 0. Cost is
   * reported as recorded spend, because only executions that recorded a cost
   * contribute to it.
   */
  async function getDashboardStats(req: Request, res: Response): Promise<void> {
    const repository = typeof req.query.repository === 'string' ? req.query.repository : 'all';
    const repoValidation = validateRepositoryFilter(repository);
    if (!repoValidation.valid) {
      res.status(400).json({ error: repoValidation.error });
      return;
    }

    const periodValidation = validateEnum(req.query.period, DASHBOARD_STATS_PERIODS, 'Period');
    if (!periodValidation.valid) {
      res.status(400).json({ error: periodValidation.error });
      return;
    }
    const period: DashboardStatsPeriod = periodValidation.value ?? '7d';

    try {
      const to = now();
      const from = analyticsTimeframeStart(period, to)!;
      const current: AnalyticsWindow = { timeframe: period, from, to };
      // The same number of whole days, ending where the current window starts:
      // `from` is the current period's first instant, so it is outside the
      // previous one, whose last whole day is the day before.
      const previousLastInstant = new Date(from.getTime() - 1);
      const previous: AnalyticsWindow = {
        timeframe: period, from: analyticsTimeframeStart(period, previousLastInstant)!, to: from, toExclusive: true,
      };

      const [currentStats, previousStats, currentSpend, previousSpend] = await timeApiStage(
        'dashboard.stats',
        () => Promise.all([
          loadTaskSummary(db, current, repository),
          loadTaskSummary(db, previous, repository),
          loadRecordedSpend(db, current, repository),
          loadRecordedSpend(db, previous, repository),
        ]),
      );

      res.json({
        period,
        repository,
        tasks: currentStats.total,
        completed: currentStats.completed,
        failed: currentStats.failed,
        successRate: calculateSuccessRate(currentStats.completed, currentStats.failed),
        recordedSpend: currentSpend,
        dailyTasks: currentStats.dailyCounts,
        previous: {
          tasks: previousStats.total,
          completed: previousStats.completed,
          successRate: calculateSuccessRate(previousStats.completed, previousStats.failed),
          recordedSpend: previousSpend,
        },
      });
    } catch (error) {
      console.error('Error in /api/stats/dashboard:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
    }
  }

  async function getGeneratingPlansCount(_req: Request, res: Response): Promise<void> {
    try {
      const countResult = await timeApiStage('sql.generating-plans.count', () => db('task_drafts')
        .count('* as count')
        .where('status', 'generating')
        .first()) as unknown as CountRow | undefined;

      res.json({
        count: Number(countResult?.count || 0)
      });
    } catch (error) {
      console.error('Error in /api/stats/generating-plans:', error);
      res.status(500).json({ error: 'Failed to fetch generating plans count' });
    }
  }

  return { getTaskStats, getRepositoryStats, getOverview, getGeneratingPlansCount, getDashboardStats };
}
