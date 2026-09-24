/**
 * Aggregated execution data for the dashboard's historical stats section.
 *
 * This is the third dashboard source of truth. It counts finished runs from
 * the outcome transitions recorded in task history — the same projection the
 * recent-outcomes feed reads — rather than from what each task happens to be
 * doing now, so a retry starting does not erase the failure that caused it.
 */

import type { Knex } from 'knex';
import { terminalTransitionQuery, toIso } from './dashboardQueries.js';

export interface CompletionStats {
  completed: number;
  failed: number;
  dailyCompleted: Array<{ date: string; count: number }>;
}

const dayKey = (iso: string): string => iso.slice(0, 10);

/**
 * Completed and failed run counts in a window.
 *
 * Each task contributes at most one completion and one failure per window —
 * the last of each it recorded there — so repeated entries for the same
 * outcome are collapsed while a run that failed before it eventually succeeded
 * still counts as both. Queued, running and cancelled work is excluded so it
 * can never enter a success-rate denominator, and a task that has since moved
 * back to running keeps the outcome it already recorded.
 */
export async function loadCompletionStats(
  db: Knex,
  repository: string,
  window: { from: Date; to: Date },
): Promise<CompletionStats> {
  const [completedRows, failedRows] = await Promise.all([
    terminalTransitionQuery(db, repository, 'completed', window)
      .select('h.timestamp as state_timestamp') as unknown as Promise<Array<{ state_timestamp: string }>>,
    terminalTransitionQuery(db, repository, 'failed', window)
      .count({ total: '*' })
      .first() as Promise<{ total?: number | string } | undefined>,
  ]);

  const dailyCounts = new Map<string, number>();
  const completed = completedRows.length;
  const failed = Number(failedRows?.total ?? 0);
  for (const row of completedRows) {
    const key = dayKey(toIso(row.state_timestamp));
    dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + 1);
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
