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
        .select('t.repository')
        .count('* as total')
        .sum(db.raw("CASE WHEN h.state = 'completed' THEN 1 ELSE 0 END as completed"))
        .sum(db.raw("CASE WHEN h.state = 'failed' THEN 1 ELSE 0 END as failed"))
        .sum(db.raw("CASE WHEN h.state NOT IN ('completed', 'failed') THEN 1 ELSE 0 END as in_progress"))
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

  return { getTaskStats, getRepositoryStats };
}
