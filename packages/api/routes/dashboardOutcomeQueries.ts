/**
 * Recorded outcome events — the dashboard's second source of truth.
 *
 * Outcomes are recorded events, so they are read from task history rather than
 * from a task's current state: a run that failed and is now being retried still
 * failed, and dropping that record would rewrite both the feed and the success
 * rate the moment the retry starts.
 */

import type { Knex } from 'knex';
import { loadCritiqueScores, toScoreNumber } from './critiqueScore.js';
import {
  loadThreadWork,
  mapTaskRow,
  TASK_COLUMNS,
  threadTitle,
  terminalTransitionQuery,
  TERMINAL_TASK_STATES,
  toIso,
  type DashboardTaskRow,
  type RawTaskRow,
} from './dashboardQueries.js';

export interface OutcomeRow extends DashboardTaskRow {
  planIssueStatus: string | null;
  /** Implementation critique score out of 10, or null when none was recorded. */
  score: number | null;
}

/**
 * Recent recorded outcomes, newest first.
 *
 * Each terminal state is read separately and merged, so one long run of
 * completions cannot crowd the failures out of the feed before the limit is
 * applied to the merged, ordered result.
 */
export async function loadOutcomeRows(
  db: Knex,
  repository: string,
  options: { limit?: number; since?: Date } = {},
): Promise<OutcomeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const perState = await Promise.all(TERMINAL_TASK_STATES.map(state =>
    terminalTransitionQuery(db, repository, state, { from: options.since })
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc')
      .limit(limit) as unknown as Promise<RawTaskRow[]>));

  const mapped = perState.flat()
    .map(mapTaskRow)
    .sort((a, b) => Date.parse(b.stateTimestamp) - Date.parse(a.stateTimestamp))
    .slice(0, limit);
  if (mapped.length === 0) return [];

  // One task can carry two outcomes (it failed, then a retry completed), so the
  // enrichment reads each task once.
  const taskIds = [...new Set(mapped.map(row => row.taskId))];
  const [planRows, scores] = await Promise.all([
    db('plan_issues')
      .whereIn('task_id', taskIds)
      .whereNotNull('task_id')
      .select('task_id', 'status')
      .orderBy('id', 'asc') as unknown as Promise<Array<Record<string, unknown>>>,
    loadCritiqueScores(db, taskIds),
  ]);
  const statusByTask = new Map<string, string>();
  for (const row of planRows) statusByTask.set(String(row.task_id), String(row.status));

  return mapped.map(row => ({
    ...row,
    planIssueStatus: statusByTask.get(row.taskId) ?? null,
    score: toScoreNumber(scores.get(row.taskId)),
  }));
}

export interface PlanIssueOutcomeRow {
  id: number;
  repository: string;
  issueNumber: number;
  prNumber: number | null;
  status: string;
  /** What was merged or closed, from the run behind it. */
  title: string | null;
  taskId: string | null;
  occurredAt: string;
}

/**
 * Review results recorded against plan issues, newest first.
 *
 * A merge or a close happens after the implementation run finished, so it is a
 * separate outcome from that run's completion rather than a duplicate of it.
 */
export async function loadPlanIssueOutcomes(
  db: Knex,
  repository: string,
  options: { limit?: number } = {},
): Promise<PlanIssueOutcomeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const query = db('plan_issues')
    .whereIn('status', ['merged', 'closed'])
    .select('id', 'repository', 'issue_number', 'pr_number', 'status', 'task_id', 'updated_at')
    .orderBy('updated_at', 'desc')
    .limit(limit);
  if (repository && repository !== 'all') query.where('repository', repository);

  const rows = await query as Array<Record<string, unknown>>;
  const outcomes = rows.map(row => ({
    id: Number(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    status: String(row.status),
    title: null,
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    occurredAt: toIso(row.updated_at),
  }));

  // A plan issue has no title of its own, so a merge row is named by the run
  // it merged. Without it the feed printed `Pull request #2467` beside a
  // `PR #2467` chip — the identifier twice, and the work not at all.
  const threads = await loadThreadWork(db, repository, outcomes.map(row => row.issueNumber));
  return outcomes.map(outcome => ({ ...outcome, title: threadTitle(threads, outcome) }));
}
