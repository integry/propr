import { Knex } from 'knex';
import { timeApiStage } from '../apiPerformanceTiming.js';

export interface TaskIdentityRow {
  task_id: unknown;
  repository: unknown;
  issue_number: unknown;
  pr_number: unknown;
  job_pr_number: unknown;
  job_issue_number: unknown;
  result_pr_number: unknown;
  /** The run's latest state, read when the newest run decides selection. */
  state?: unknown;
  /** 1 when the run matches the search text. */
  matches_search?: unknown;
}

const positiveNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

/**
 * The runs of each task, newest task first and each task's runs newest first,
 * grouped exactly as the task list groups runs into rows: by pull request,
 * else by issue, else alone, with an issue's runs joining the pull request a
 * run links to that issue. Rows must arrive newest first; a task is as new as
 * its newest run.
 */
export function groupRunsByTask<T extends TaskIdentityRow>(rows: T[]): T[][] {
  // Groups keep insertion order, so each one sits where its newest run does.
  const groups = new Map<string, { newest: number; runs: Array<{ row: T; index: number }> }>();
  const issueToPr = new Map<string, string>();
  rows.forEach((row, index) => {
    const repository = typeof row.repository === 'string' && row.repository ? row.repository : 'unknown/unknown';
    const prNumber = positiveNumber(row.pr_number) ?? positiveNumber(row.job_pr_number) ?? positiveNumber(row.result_pr_number);
    const issueNumber = positiveNumber(row.issue_number);
    const linkedIssue = positiveNumber(row.job_issue_number);
    if (prNumber && linkedIssue) issueToPr.set(`${repository}-issue-${linkedIssue}`, `${repository}-pr-${prNumber}`);
    const key = prNumber ? `${repository}-pr-${prNumber}` : issueNumber ? `${repository}-issue-${issueNumber}` : `task-${String(row.task_id)}`;
    const group = groups.get(key);
    if (group) group.runs.push({ row, index });
    else groups.set(key, { newest: index, runs: [{ row, index }] });
  });
  // An issue's runs join the pull request a run opened for it; the task is as new as the newer of the two.
  for (const [issueKey, prKey] of issueToPr) {
    const issue = groups.get(issueKey);
    const pr = groups.get(prKey);
    if (!issue || !pr) continue;
    pr.runs.push(...issue.runs);
    pr.newest = Math.min(pr.newest, issue.newest);
    groups.delete(issueKey);
  }
  return [...groups.values()]
    .sort((a, b) => a.newest - b.newest)
    .map(group => group.runs.sort((a, b) => a.index - b.index).map(run => run.row));
}

/**
 * Which tasks a grouped page lists. A task is one thing with one state, its
 * newest run's, so a state filter asks only that run; the runs behind it are
 * history, not the task's state. Search and the attention set pick a task
 * when any of its runs matches. Either way the page then returns every run of
 * the tasks it lists, never only the runs that matched.
 */
export interface TaskSelection {
  /** Whether the newest run's state lists the task. */
  newestRunState?: (state: string) => boolean;
  /** Run ids any of which lists its task. */
  anyRunIn?: ReadonlySet<string>;
  /** Text any run of the task must match. */
  search?: string;
}

export interface TaskPageBounds {
  total: number;
  totalRuns: number;
  /** The page holds no task, so there is nothing to read. */
  empty: boolean;
}

/**
 * Narrows `pageQuery` to one page of tasks and counts them. Every run in
 * scope has its identity read, so a page boundary falls between tasks, never
 * between the runs of one, and selection sees each task whole. `scopeQuery`
 * and `pageQuery` carry the scope (repository, task kind) but no selection:
 * the page query then fetches its tasks' runs whole.
 */
export async function narrowToTaskPage(
  db: Knex,
  scopeQuery: Knex.QueryBuilder,
  pageQuery: Knex.QueryBuilder,
  { selection, limit, offset }: { selection: TaskSelection; limit: number; offset: number },
): Promise<TaskPageBounds> {
  const identityQuery = scopeQuery.clone();
  const columns: Array<string | Knex.Raw> = [
    't.task_id', 't.repository', 't.issue_number', 't.pr_number',
    db.raw(`CASE WHEN json_valid(t.initial_job_data) THEN json_extract(t.initial_job_data, '$.pullRequestNumber') END AS job_pr_number`),
    db.raw(`CASE WHEN json_valid(t.initial_job_data) THEN json_extract(t.initial_job_data, '$.issueNumber') END AS job_issue_number`),
    db.raw(`CASE WHEN json_valid(t.final_result) THEN json_extract(t.final_result, '$.postProcessing.pr.number') END AS result_pr_number`),
  ];
  if (selection.newestRunState) {
    columns.push('h.state');
  } else {
    // The latest history row is irrelevant without a state filter. Keep
    // excluding runs without history with an index-only existence check.
    identityQuery.clear('join').whereExists(
      db('task_history as count_h').select(db.raw('1')).whereRaw('count_h.task_id = t.task_id')
    );
  }
  if (selection.search) {
    const term = `%${selection.search}%`;
    columns.push(db.raw(
      `CASE WHEN t.repository LIKE ? OR CAST(t.issue_number AS TEXT) LIKE ? OR t.initial_job_data LIKE ? THEN 1 ELSE 0 END AS matches_search`,
      [term, term, term],
    ));
  }
  const identities = await timeApiStage('sql.tasks.identities', () => identityQuery
    .select(...columns)
    .orderBy('t.created_at', 'desc')) as TaskIdentityRow[];

  const { newestRunState, anyRunIn, search } = selection;
  const tasks = groupRunsByTask(identities).filter(runs =>
    (!newestRunState || newestRunState(String(runs[0].state ?? ''))) &&
    (!anyRunIn || runs.some(run => anyRunIn.has(String(run.task_id)))) &&
    (!search || runs.some(run => Number(run.matches_search) === 1)));
  const pageRunIds = tasks.slice(offset, offset + limit).flat().map(run => String(run.task_id));
  if (pageRunIds.length > 0) pageQuery.whereIn('t.task_id', pageRunIds);
  return {
    total: tasks.length,
    totalRuns: tasks.reduce((count, runs) => count + runs.length, 0),
    empty: pageRunIds.length === 0,
  };
}
