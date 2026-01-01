import { Request, Response } from 'express';
import { Knex } from 'knex';

interface StatsRoutesDeps {
  db: Knex;
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

  async function getTaskStats(_req: Request, res: Response): Promise<void> {
    try {
      // Get task counts by day for the last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString();

      // Daily task counts
      const dailyCounts = await db('tasks')
        .select(db.raw("date(created_at) as date"))
        .count('* as count')
        .where('created_at', '>=', thirtyDaysAgoStr)
        .groupByRaw('date(created_at)')
        .orderBy('date', 'asc') as unknown as DailyCountRow[];

      // Status distribution from latest task_history entries
      const statusDistribution = await db('task_history as h')
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
        .groupBy('h.state') as unknown as StatusDistributionRow[];

      // Average processing time by day (for completed tasks)
      const avgProcessingTime = await db('tasks as t')
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
        )
        .where('t.created_at', '>=', thirtyDaysAgoStr)
        .groupByRaw('date(t.created_at)')
        .orderBy('date', 'asc') as unknown as AvgProcessingTimeRow[];

      // Total counts for summary
      const totalCounts = await db('tasks')
        .count('* as total')
        .first() as unknown as CountRow | undefined;

      const completedCount = await db('task_history')
        .countDistinct('task_id as count')
        .where('state', 'completed')
        .first() as unknown as CountRow | undefined;

      const failedCount = await db('task_history')
        .countDistinct('task_id as count')
        .where('state', 'failed')
        .first() as unknown as CountRow | undefined;

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

  async function getRepositoryStats(_req: Request, res: Response): Promise<void> {
    try {
      // Get task counts and success rates per repository
      const repoStats = await db('tasks as t')
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
        .limit(20) as unknown as RepositoryStatsRow[];

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

  async function getOverview(_req: Request, res: Response): Promise<void> {
    try {
      // 1. Task Stats - count completed tasks (latest state = completed)
      // Using subquery to get the latest state for each task
      const taskStats = await db('task_history as h')
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
        )
        .first() as unknown as OverviewTaskStats | undefined;

      // 2. Token & Cost Usage from llm_execution_details and llm_executions
      const usageStats = await db('llm_execution_details')
        .sum({
          inputTokens: 'token_count_input',
          outputTokens: 'token_count_output'
        })
        .first() as unknown as UsageAggregation | undefined;

      const costStats = await db('llm_executions')
        .sum({
          cost: 'cost_usd'
        })
        .first() as unknown as { cost: number | string | null } | undefined;

      // 3. Model Distribution - count tasks per model
      const modelStats = await db('tasks')
        .select('model_name')
        .count('* as count')
        .whereNotNull('model_name')
        .groupBy('model_name') as unknown as ModelCountRow[];

      // Format model stats as object
      const modelDistribution: Record<string, number> = {};
      for (const row of modelStats) {
        if (row.model_name) {
          modelDistribution[row.model_name] = Number(row.count);
        }
      }

      // 4. PR Iterations Average - for PR-related tasks, count how many tasks share the same issue
      // This gives an indication of follow-up iterations
      const prIterations = await db('tasks')
        .select('repository', 'issue_number')
        .count('* as task_count')
        .whereNotNull('issue_number')
        .groupBy('repository', 'issue_number')
        .having(db.raw('count(*) > 1')) as unknown as PrIterationRow[];

      // Calculate average iterations (tasks per issue for issues with multiple tasks)
      let prIterationsAvg = 0;
      if (prIterations.length > 0) {
        const totalIterations = prIterations.reduce((sum, row) => sum + Number(row.task_count), 0);
        prIterationsAvg = Number((totalIterations / prIterations.length).toFixed(1));
      }

      // 5. Repos Indexed - count repositories with last_indexed_at not null
      const repoStats = await db('repositories')
        .count('* as count')
        .whereNotNull('last_indexed_at')
        .first() as unknown as CountRow | undefined;

      // Calculate totals
      const inputTokens = Number(usageStats?.inputTokens || 0);
      const outputTokens = Number(usageStats?.outputTokens || 0);
      const totalTokens = inputTokens + outputTokens;
      const totalCost = Number(costStats?.cost || 0);

      res.json({
        tasks: {
          completed: Number(taskStats?.completed || 0),
          planned: Number(taskStats?.planned || 0),
          pr_iterations_avg: prIterationsAvg
        },
        usage: {
          total_tokens: totalTokens,
          total_cost_usd: Number(totalCost.toFixed(2)),
          models: modelDistribution
        },
        system: {
          repos_indexed: Number(repoStats?.count || 0)
        }
      });
    } catch (error) {
      console.error('Error in /api/stats/overview:', error);
      res.status(500).json({ error: 'Failed to fetch overview statistics' });
    }
  }

  return { getTaskStats, getRepositoryStats, getOverview };
}
