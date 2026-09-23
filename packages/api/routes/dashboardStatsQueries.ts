/**
 * Aggregated execution data for the dashboard's historical stats section.
 *
 * This is the third dashboard source of truth. It reads the same latest-task-
 * state projection as the attention and active lists, so a completed run is
 * counted the same way everywhere.
 */

import type { Knex } from 'knex';
import { latestTaskStateQuery, toIso } from './dashboardQueries.js';

export interface CompletionStats {
  completed: number;
  failed: number;
  dailyCompleted: Array<{ date: string; count: number }>;
}

const dayKey = (iso: string): string => iso.slice(0, 10);

/**
 * Completed and failed run counts in a window.
 *
 * Queued, running and cancelled work is excluded so it can never enter a
 * success-rate denominator.
 */
export async function loadCompletionStats(
  db: Knex,
  repository: string,
  window: { from: Date; to: Date },
): Promise<CompletionStats> {
  const rows = await latestTaskStateQuery(db, repository)
    .whereIn('h.state', ['completed', 'failed'])
    .where('h.timestamp', '>=', window.from.toISOString())
    .where('h.timestamp', '<', window.to.toISOString())
    .select('h.state', 'h.timestamp as state_timestamp') as unknown as Array<{ state: string; state_timestamp: string }>;

  const dailyCounts = new Map<string, number>();
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.state === 'completed') {
      completed += 1;
      const key = dayKey(toIso(row.state_timestamp));
      dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + 1);
    } else {
      failed += 1;
    }
  }

  const dailyCompleted: Array<{ date: string; count: number }> = [];
  for (let day = new Date(window.from); day < window.to; day = new Date(day.getTime() + 24 * 60 * 60 * 1000)) {
    const key = dayKey(day.toISOString());
    dailyCompleted.push({ date: key, count: dailyCounts.get(key) ?? 0 });
  }

  return { completed, failed, dailyCompleted };
}

/**
 * Success rate over finished work only, as a percentage with one decimal.
 * Returns null when nothing finished: an unknown rate is never 0.
 */
export function successRate(completed: number, failed: number): number | null {
  const finished = completed + failed;
  if (finished <= 0) return null;
  return Number(((completed / finished) * 100).toFixed(1));
}

/**
 * Spend actually recorded against executions in a window.
 *
 * Returns null when no cost was recorded at all; an instance that never records
 * cost must not be shown as having spent $0.
 */
export async function loadRecordedSpend(
  db: Knex,
  repository: string,
  window: { from: Date; to: Date },
): Promise<number | null> {
  const query = db('llm_executions as e')
    .whereNotNull('e.cost_usd')
    .where('e.start_time', '>=', window.from.toISOString())
    .where('e.start_time', '<', window.to.toISOString());
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
