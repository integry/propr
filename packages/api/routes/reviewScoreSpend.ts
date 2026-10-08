/**
 * What each merged, scored pull request cost and how many runs it took: the
 * spend behind review quality's cost per merged PR and runs to merge.
 *
 * A PR's tasks are attached as the delivery band attaches them — every
 * implementation attempt at its issue up to the PR's merge, whether or not
 * the attempt opened the PR, and every task acting on the PR — so the
 * efficacy matrix and the delivery band count one PR's work alike. An
 * attempt at the issue after the merge belongs to whatever PR it opens next,
 * never to the one already merged.
 */

import type { Knex } from 'knex';
import { chunk } from './dashboardQueries.js';
import {
  atOrBefore, attachedTasks, indexRelatedTasks, isImplementationAttempt, loadRelatedTasks, loadRunsToMerge, taskColumns,
  type PullRequest, type TaskRow,
} from './analyticsDelivery.js';

export interface PullRequestSpend { cost: number | null; runs: number }

const prKey = (repository: string, prNumber: number | string): string => `${repository}#${Number(prNumber)}`;

interface CostRow {
  task_id: string;
  cost: number | string | null;
  costed: number | string;
}

/** Recorded cost per task over its whole life, and whether any execution recorded one. */
async function loadTaskCosts(db: Knex, taskIds: string[]): Promise<Map<string, { cost: number; costed: number }>> {
  const costs = new Map<string, { cost: number; costed: number }>();
  for (const batch of chunk(taskIds)) {
    const rows = await db('llm_executions')
      .whereIn('task_id', batch)
      .select('task_id')
      .sum('cost_usd as cost')
      .count('cost_usd as costed')
      .groupBy('task_id') as unknown as CostRow[];
    for (const row of rows) costs.set(row.task_id, { cost: Number(row.cost || 0), costed: Number(row.costed) });
  }
  return costs;
}

/**
 * Each merged PR's issue, from the task that opened it: the earliest task
 * recorded with the PR number that is neither a goal nor a task acting on
 * the PR. A PR ProPR did not open has no issue and only its follow-ups.
 */
function issueNumbers(merged: Array<Pick<PullRequest, 'repository' | 'prNumber'>>, tasks: TaskRow[]): Map<string, number | null> {
  const openers = new Map<string, TaskRow>();
  for (const task of tasks) {
    if (task.pr_number === null || !isImplementationAttempt(task, { repository: task.repository, prNumber: Number(task.pr_number), issueNumber: null })) continue;
    const key = prKey(task.repository, task.pr_number);
    const known = openers.get(key);
    if (!known || task.created_at < known.created_at) openers.set(key, task);
  }
  return new Map(merged.map(pr => {
    const key = prKey(pr.repository, pr.prNumber);
    const opener = openers.get(key);
    return [key, opener?.issue_number === null || opener?.issue_number === undefined ? null : Number(opener.issue_number)];
  }));
}

/**
 * Recorded cost and run count per merged pull request over the tasks the
 * delivery band attaches to it: every implementation attempt at its issue
 * created at or before the merge, whether or not the attempt opened the PR,
 * and every task acting on the PR. Cost is the PR's lifetime spend over those
 * tasks, so a review after the merge still counts, but a later attempt at the
 * same issue (one that opens the next PR) does not inflate the merged PR's
 * cost. Runs stop at the recorded merge, so a review after the merge never
 * adds a run to merge.
 */
export async function loadPullRequestCosts(
  db: Knex, merged: Array<Pick<PullRequest, 'repository' | 'prNumber'> & { mergedAt: string | null }>,
): Promise<Map<string, PullRequestSpend>> {
  if (!merged.length) return new Map();
  const repositories = [...new Set(merged.map(pr => pr.repository))];
  const columns = await taskColumns(db);
  // The tasks naming each PR find its issue; the tasks naming that issue are its other attempts.
  const byPullRequest = await loadRelatedTasks(db, repositories, [...new Set(merged.map(pr => pr.prNumber))], columns);
  const issues = issueNumbers(merged, byPullRequest);
  const issueOnly = [...new Set([...issues.values()].flatMap(issue => issue === null ? [] : [issue]))]
    .filter(issue => !merged.some(pr => pr.prNumber === issue));
  const byIssue = issueOnly.length ? await loadRelatedTasks(db, repositories, issueOnly, columns) : [];
  const index = indexRelatedTasks([...byPullRequest, ...byIssue]);

  const attached = new Map<string, TaskRow[]>();
  for (const pr of merged) {
    const key = prKey(pr.repository, pr.prNumber);
    const { implementations, followUps } = attachedTasks({ ...pr, issueNumber: issues.get(key) ?? null }, index);
    attached.set(key, [...implementations.filter(task => atOrBefore(task.created_at, pr.mergedAt)), ...followUps]);
  }
  const [costs, runs] = await Promise.all([
    loadTaskCosts(db, [...new Set([...attached.values()].flat().map(task => task.task_id))]),
    loadRunsToMerge(db, merged.flatMap(pr => {
      const key = prKey(pr.repository, pr.prNumber);
      return (attached.get(key) ?? []).map(task => ({ key, taskId: task.task_id, mergedAt: pr.mergedAt }));
    })),
  ]);
  const spend = new Map<string, PullRequestSpend>();
  for (const [key, tasks] of attached) {
    let cost = 0;
    let costed = 0;
    for (const task of tasks) {
      const known = costs.get(task.task_id);
      if (!known) continue;
      cost += known.cost;
      costed += known.costed;
    }
    spend.set(key, { cost: costed === 0 ? null : cost, runs: runs.get(key) ?? 0 });
  }
  return spend;
}
