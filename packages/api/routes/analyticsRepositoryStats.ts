/**
 * Repository performance for the Analytics page: the totals band's task
 * figures, per repository.
 *
 * A task is counted as the totals band counts it (`loadTaskSummary`): a pull
 * request with every run on it, or its issue before a PR exists, goal tasks
 * aside, created inside the window. Completed and failed mean the same as
 * there — a task with a run that recorded a completion, or a failure — so the
 * per-repository success rate, completed / (completed + failed), is the
 * header's success rate restricted to one repository.
 *
 * In progress is only open work: a task with a run whose latest state is
 * queued or running. A task that is none of completed, failed or in progress
 * — cancelled, skipped, superseded, waiting on an operator, or never started —
 * is counted under `other`, never as in progress.
 */

import type { Knex } from 'knex';
import { successRate } from './dashboardStatsQueries.js';
import { excludeGoalTasks, groupTaskRuns, loadTaskRuns } from './analyticsAggregates.js';
import { isQueuedState, isRunningState } from './dashboardQueries.js';
import { whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';

export interface RepositoryTaskStats {
  repository: string;
  /** Tasks worked on in the window. */
  total: number;
  /** Tasks with a run that recorded a completion. */
  completed: number;
  /** Tasks with a run that recorded a failure. */
  failed: number;
  /** Tasks with a run that is queued or running now. */
  inProgress: number;
  /** Tasks that are none of the above: cancelled, skipped, superseded or awaiting an operator. */
  other: number;
  /** completed / (completed + failed), as a percentage to one decimal; null when nothing finished. */
  successRate: number | null;
}

/** How many repositories the table lists, busiest first. */
export const REPOSITORY_STATS_LIMIT = 20;

export async function loadRepositoryTaskStats(db: Knex, window: AnalyticsWindow | null): Promise<RepositoryTaskStats[]> {
  // The completions and failures each run recorded, read as the totals band reads them.
  const outcomesQuery = db('task_history as h')
    .join('tasks as t', 't.task_id', 'h.task_id')
    .distinct('h.task_id', 'h.state')
    .whereIn('h.state', ['completed', 'failed']);
  whereCreatedWithin(outcomesQuery, 't.created_at', window);
  excludeGoalTasks(outcomesQuery, 't.task_type');

  // Each run's latest state: one row per run, not its whole history.
  const latestQuery = db('tasks as t').select(
    't.task_id',
    db.raw('(SELECT h.state FROM task_history h WHERE h.task_id = t.task_id ORDER BY h.timestamp DESC, h.history_id DESC LIMIT 1) as state'),
  );
  whereCreatedWithin(latestQuery, 't.created_at', window);
  excludeGoalTasks(latestQuery, 't.task_type');

  const [{ runs, linkageRows }, outcomes, latestRows] = await Promise.all([
    loadTaskRuns(db, window, 'all'),
    outcomesQuery as unknown as Promise<Array<{ task_id: string; state: string }>>,
    latestQuery as unknown as Promise<Array<{ task_id: string; state: string | null }>>,
  ]);

  const reached = new Map<string, Set<string>>();
  for (const row of outcomes) {
    const taskId = String(row.task_id);
    const states = reached.get(taskId) ?? new Set<string>();
    states.add(row.state);
    reached.set(taskId, states);
  }
  const latest = new Map<string, string>();
  for (const row of latestRows) if (row.state) latest.set(String(row.task_id), row.state);

  const byRepository = new Map<string, Omit<RepositoryTaskStats, 'successRate'>>();
  for (const task of groupTaskRuns(runs, linkageRows).values()) {
    const repository = task[0].repository || 'unknown/unknown';
    const stats = byRepository.get(repository)
      ?? { repository, total: 0, completed: 0, failed: 0, inProgress: 0, other: 0 };
    const ids = task.map(run => String(run.task_id));
    const completed = ids.some(id => reached.get(id)?.has('completed'));
    const failed = ids.some(id => reached.get(id)?.has('failed'));
    const open = ids.some(id => {
      const state = latest.get(id);
      return state !== undefined && (isQueuedState(state) || isRunningState(state));
    });
    stats.total += 1;
    if (completed) stats.completed += 1;
    if (failed) stats.failed += 1;
    if (open) stats.inProgress += 1;
    if (!completed && !failed && !open) stats.other += 1;
    byRepository.set(repository, stats);
  }

  return [...byRepository.values()]
    .sort((a, b) => b.total - a.total || a.repository.localeCompare(b.repository))
    .slice(0, REPOSITORY_STATS_LIMIT)
    .map(stats => ({ ...stats, successRate: successRate(stats.completed, stats.failed) }));
}
