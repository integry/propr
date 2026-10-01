import { Request, Response } from 'express';
import { Knex } from 'knex';
import { timeApiStage } from '../apiPerformanceTiming.js';
import { validateEnum, validateRepositoryFilter } from './validation.js';
import { loadCompletionStats, loadRecordedSpend, successRate as calculateSuccessRate } from './dashboardStatsQueries.js';
import { analyticsDayKeys, readAnalyticsWindow, whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { loadModelUsage } from './analyticsModelUsage.js';

/** Periods the dashboard's historical stats section can request. */
export const DASHBOARD_STATS_PERIODS = ['7d', '30d'] as const;
export type DashboardStatsPeriod = typeof DASHBOARD_STATS_PERIODS[number];

const PERIOD_DAYS: Record<DashboardStatsPeriod, number> = { '7d': 7, '30d': 30 };

/** Window boundaries are whole days so the daily chart buckets line up. */
function statsWindow(now: Date, days: number): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { from: new Date(to.getTime() - days * 24 * 60 * 60 * 1000), to };
}

interface StatsRoutesDeps {
  db: Knex;
  /** Seam for tests that need a fixed window. */
  now?: () => Date;
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
  cost: number | string | null;
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

export function createStatsRoutes(deps: StatsRoutesDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function getTaskStats(req: Request, res: Response): Promise<void> {
    const analyticsWindow = readAnalyticsWindow(req, res, now());
    if (analyticsWindow === false) return;

    try {
      // Without a period: task counts by day for the last 30 days
      const thirtyDaysAgo = new Date(now().getTime());
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString();

      // Daily task counts
      const dailyCountsQuery = db('tasks')
        .select(db.raw("date(created_at) as date"))
        .count('* as count');
      if (analyticsWindow) {
        whereCreatedWithin(dailyCountsQuery, 'created_at', analyticsWindow);
      } else {
        dailyCountsQuery.where('created_at', '>=', thirtyDaysAgoStr);
      }
      const dailyCountRows = await dailyCountsQuery
        .groupByRaw('date(created_at)')
        .orderBy('date', 'asc') as unknown as DailyCountRow[];

      // With a period every day in the window is listed, including empty ones
      let dailyCounts = dailyCountRows;
      if (analyticsWindow) {
        const counts = new Map(dailyCountRows.map(row => [String(row.date), Number(row.count)]));
        const from = analyticsWindow.from ?? (dailyCountRows.length > 0 ? new Date(`${dailyCountRows[0].date}T00:00:00.000Z`) : null);
        dailyCounts = from
          ? analyticsDayKeys(from, analyticsWindow.to).map(date => ({ date, count: counts.get(date) ?? 0 }))
          : [];
      }

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

      // Total counts for summary
      const totalCountsQuery = db('tasks').count('* as total');
      whereCreatedWithin(totalCountsQuery, 'created_at', analyticsWindow);
      const totalCounts = await totalCountsQuery.first() as unknown as CountRow | undefined;

      const outcomeCount = (state: string): Promise<CountRow | undefined> => {
        const query = db('task_history as h')
          .countDistinct('h.task_id as count')
          .where('h.state', state);
        if (analyticsWindow) {
          query.join('tasks as t', 't.task_id', 'h.task_id');
          whereCreatedWithin(query, 't.created_at', analyticsWindow);
        }
        return query.first() as unknown as Promise<CountRow | undefined>;
      };
      const completedCount = await outcomeCount('completed');
      const failedCount = await outcomeCount('failed');

      res.json({
        dailyCounts: dailyCounts.map((row) => ({
          date: String(row.date),
          count: Number(row.count)
        })),
        statusDistribution: statusDistribution.map((row) => ({
          status: String(row.state),
          count: Number(row.count)
        })),
        avgProcessingTime: avgProcessingTime.map((row) => ({
          date: String(row.date),
          avgMinutes: row.avg_minutes ? Number(Number(row.avg_minutes).toFixed(2)) : 0
        })),
        summary: {
          total: Number(totalCounts?.total || 0),
          completed: Number(completedCount?.count || 0),
          failed: Number(failedCount?.count || 0)
        }
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

    const costStatsQuery = db('llm_executions')
      .sum({
        cost: 'cost_usd'
      });
    whereCreatedWithin(costStatsQuery, 'start_time', analyticsWindow);
    const costStats = await costStatsQuery.first() as unknown as { cost: number | string | null } | undefined;

    // Model Distribution - count unique tasks per model from llm_executions
    // This gives accurate counts since a task may use multiple models or have retries
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
    const totalCost = Number(costStats?.cost || 0);
    return {
      total_tokens: inputTokens + outputTokens,
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
      const modelUsage = await loadModelUsage(db, analyticsWindow);

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
        usage,
        model_usage: modelUsage,
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
    const days = PERIOD_DAYS[period];

    try {
      const current = statsWindow(now(), days);
      const previous = { from: new Date(current.from.getTime() - days * 24 * 60 * 60 * 1000), to: current.from };

      const [currentStats, previousStats, currentSpend, previousSpend] = await timeApiStage(
        'dashboard.stats',
        () => Promise.all([
          loadCompletionStats(db, repository, current),
          loadCompletionStats(db, repository, previous),
          loadRecordedSpend(db, repository, current),
          loadRecordedSpend(db, repository, previous),
        ]),
      );

      res.json({
        period,
        repository,
        completed: currentStats.completed,
        successRate: calculateSuccessRate(currentStats.completed, currentStats.failed),
        recordedSpend: currentSpend,
        dailyCompleted: currentStats.dailyCompleted,
        previous: {
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
