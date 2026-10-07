/**
 * Delivery metrics for the Analytics page: what the agents shipped, how fast,
 * how often on the first attempt, and how often a human had to step in.
 *
 * The unit is a pull request opened by a task created in the window (a task
 * row with `pr_number` set). Every task attached to that PR is part of its
 * history: the implementation attempts on its issue, and the follow-up tasks
 * acting on the PR itself. Outcomes come from `notification_pull_request_state`,
 * the same merge marker review quality reads.
 *
 * Every figure carries its denominator, and a figure with nothing behind it is
 * null, never 0.
 */

import type { Knex } from 'knex';
import { whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { ATTENTION_TASK_STATES, chunk } from './dashboardQueries.js';
import { isPullRequestTask } from './pullRequestTaskIdentity.js';

export interface DeliveryMetrics {
  /** Pull requests opened by tasks created in the window. */
  prs_opened: number;
  prs_merged: number;
  prs_closed: number;
  /**
   * Merged PRs that needed no fix: one implementation run of their issue, no
   * follow-up fix task on the PR and no Ultrafix fix cycle. n is merged PRs.
   */
  first_time_pass: { rate: number | null; passed: number; n: number };
  /** Wall-clock minutes from the issue's first task to the merge. n is merged PRs with a merge time. */
  time_to_merge_minutes: { mean: number | null; median: number | null; n: number };
  /** Agent executions across each merged PR's tasks. */
  runs_per_merged_pr: { mean: number | null; n: number };
}

export interface AutonomyMetrics {
  /** Share of finished tasks that never needed an operator, 0–1. */
  rate: number | null;
  autonomous: number;
  /** Finished tasks that failed or asked for a human at any point. */
  operator: number;
  n: number;
}

interface TaskRow {
  task_id: string;
  repository: string;
  issue_number: number | null;
  pr_number: number | null;
  task_type: string | null;
  created_at: string;
  initial_job_data?: string | null;
}

interface PullRequest {
  repository: string;
  prNumber: number;
  issueNumber: number | null;
}

const prKey = (repository: string, prNumber: number | string): string => `${repository}#${Number(prNumber)}`;
const round = (value: number, digits = 2): number => Number(value.toFixed(digits));
const mean = (values: number[]): number | null =>
  values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2);
}

const toTime = (value: string | Date): number => new Date(value).getTime();

/** Reviews and Ultrafix cycles are judged elsewhere; any other task acting on a PR is a fix. */
function isFixTask(task: TaskRow): boolean {
  if (task.task_type === 'review') return false;
  let data: { commandMode?: unknown; ultrafixMeta?: unknown } = {};
  try {
    data = task.initial_job_data ? JSON.parse(task.initial_job_data) as typeof data : {};
  } catch {
    data = {};
  }
  return data.commandMode !== 'review' && !data.ultrafixMeta;
}

async function loadOutcomes(db: Knex, pullRequests: PullRequest[]): Promise<Map<string, { merged_at: string | null; outcome: string | null }>> {
  const outcomes = new Map<string, { merged_at: string | null; outcome: string | null }>();
  if (!pullRequests.length || !await db.schema.hasTable('notification_pull_request_state')) return outcomes;
  const hasOutcome = await db.schema.hasColumn('notification_pull_request_state', 'outcome');
  const repositories = [...new Set(pullRequests.map(pr => pr.repository))];
  for (const numbers of chunk([...new Set(pullRequests.map(pr => pr.prNumber))])) {
    const rows = await db('notification_pull_request_state')
      .whereIn('repository', repositories)
      .whereIn('pr_number', numbers)
      .select(['repository', 'pr_number', 'merged_at', ...(hasOutcome ? ['outcome'] : [])]) as Array<{
        repository: string; pr_number: number; merged_at: string | null; outcome?: string | null;
      }>;
    for (const row of rows) outcomes.set(prKey(row.repository, row.pr_number), { merged_at: row.merged_at, outcome: row.outcome ?? null });
  }
  return outcomes;
}

/** PRs whose Ultrafix loop ran a fix: a scored cycle after the first. */
async function loadUltrafixFixedPullRequests(db: Knex, pullRequests: PullRequest[]): Promise<Set<string>> {
  const fixed = new Set<string>();
  if (!pullRequests.length || !await db.schema.hasTable('review_scores')) return fixed;
  const repositories = [...new Set(pullRequests.map(pr => pr.repository))];
  for (const numbers of chunk([...new Set(pullRequests.map(pr => pr.prNumber))])) {
    const rows = await db('review_scores')
      .whereIn('repository_id', repositories)
      .whereIn('pr_number', numbers)
      .where('source', 'ultrafix')
      .where('cycle_number', '>', 1)
      .distinct('repository_id', 'pr_number') as Array<{ repository_id: string; pr_number: number }>;
    for (const row of rows) fixed.add(prKey(row.repository_id, row.pr_number));
  }
  return fixed;
}

const TASK_COLUMNS = ['task_id', 'repository', 'issue_number', 'pr_number', 'task_type', 'created_at'];

/** Task columns to read; `initial_job_data` only tells reviews apart, so a schema without it reads every follow-up as a fix. */
async function taskColumns(db: Knex): Promise<string[]> {
  return await db.schema.hasColumn('tasks', 'initial_job_data') ? [...TASK_COLUMNS, 'initial_job_data'] : TASK_COLUMNS;
}

/** Every task in the given repositories that names one of the numbers, by issue or PR. */
async function loadRelatedTasks(db: Knex, repositories: string[], numbers: number[], columns: string[]): Promise<TaskRow[]> {
  const rows: TaskRow[] = [];
  for (const batch of chunk(numbers)) {
    rows.push(...await db('tasks')
      .whereIn('repository', repositories)
      .where(function (this: Knex.QueryBuilder) {
        this.whereIn('issue_number', batch).orWhereIn('pr_number', batch);
      })
      .select(columns) as TaskRow[]);
  }
  return rows;
}

async function loadRunCounts(db: Knex, taskIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const batch of chunk(taskIds)) {
    const rows = await db('llm_executions')
      .whereIn('task_id', batch)
      .select('task_id')
      .count('* as runs')
      .groupBy('task_id') as Array<{ task_id: string; runs: number | string }>;
    for (const row of rows) counts.set(row.task_id, Number(row.runs));
  }
  return counts;
}

interface MergedPullRequest {
  firstTimePass: boolean;
  runs: number;
  /** Null when the merge time or the submission is unknown. */
  minutesToMerge: number | null;
}

/** How one merged PR got there: its implementation attempts and the follow-ups acting on it. */
function mergedPullRequestFacts(
  pr: PullRequest & { mergedAt: string | null; ultrafixFixed: boolean }, related: TaskRow[], runs: Map<string, number>,
): MergedPullRequest {
  const { mergedAt, ultrafixFixed } = pr;
  const sameRepository = related.filter(task => task.repository === pr.repository);
  const implementations = sameRepository.filter(task => !isPullRequestTask(task)
    && (Number(task.pr_number) === pr.prNumber || (pr.issueNumber !== null && Number(task.issue_number) === pr.issueNumber)));
  const followUps = sameRepository.filter(task => isPullRequestTask(task) && Number(task.issue_number) === pr.prNumber);
  const runsOf = (tasks: TaskRow[]) => tasks.reduce((sum, task) => sum + (runs.get(task.task_id) ?? 0), 0);

  let minutesToMerge: number | null = null;
  if (mergedAt && implementations.length) {
    const minutes = (toTime(mergedAt) - Math.min(...implementations.map(task => toTime(task.created_at)))) / 60_000;
    if (Number.isFinite(minutes) && minutes >= 0) minutesToMerge = minutes;
  }
  return {
    firstTimePass: implementations.length <= 1 && runsOf(implementations) <= 1 && !followUps.some(isFixTask) && !ultrafixFixed,
    runs: runsOf([...implementations, ...followUps]),
    minutesToMerge,
  };
}

/** Pull requests opened by tasks created in the window, once each. */
async function loadOpenedPullRequests(db: Knex, window: AnalyticsWindow | null, columns: string[]): Promise<Map<string, PullRequest>> {
  const query = db('tasks').whereNotNull('pr_number').select(columns);
  whereCreatedWithin(query, 'created_at', window);
  const pullRequests = new Map<string, PullRequest>();
  for (const task of await query as TaskRow[]) {
    const key = prKey(task.repository, task.pr_number!);
    if (isPullRequestTask(task) || pullRequests.has(key)) continue;
    pullRequests.set(key, { repository: task.repository, prNumber: Number(task.pr_number), issueNumber: task.issue_number });
  }
  return pullRequests;
}

export async function loadDeliveryMetrics(db: Knex, window: AnalyticsWindow | null): Promise<DeliveryMetrics> {
  const columns = await taskColumns(db);
  const pullRequests = await loadOpenedPullRequests(db, window, columns);
  const prs = [...pullRequests.values()];
  const repositories = [...new Set(prs.map(pr => pr.repository))];
  const numbers = [...new Set(prs.flatMap(pr => pr.issueNumber === null ? [pr.prNumber] : [pr.prNumber, pr.issueNumber]))];

  const [outcomes, ultrafixFixed, related] = await Promise.all([
    loadOutcomes(db, prs),
    loadUltrafixFixedPullRequests(db, prs),
    repositories.length ? loadRelatedTasks(db, repositories, numbers, columns) : Promise.resolve([] as TaskRow[]),
  ]);
  const runs = await loadRunCounts(db, related.map(task => task.task_id));

  let closed = 0;
  const merged: MergedPullRequest[] = [];
  for (const [key, pr] of pullRequests) {
    const outcome = outcomes.get(key);
    if (outcome?.outcome === 'merged' || outcome?.merged_at) {
      merged.push(mergedPullRequestFacts({ ...pr, mergedAt: outcome.merged_at, ultrafixFixed: ultrafixFixed.has(key) }, related, runs));
    } else if (outcome?.outcome === 'closed') {
      closed += 1;
    }
  }

  const passed = merged.filter(pr => pr.firstTimePass).length;
  const minutesToMerge = merged.flatMap(pr => pr.minutesToMerge === null ? [] : [pr.minutesToMerge]);
  const runsToMerge = merged.map(pr => pr.runs);
  return {
    prs_opened: pullRequests.size,
    prs_merged: merged.length,
    prs_closed: closed,
    first_time_pass: { rate: merged.length ? round(passed / merged.length, 4) : null, passed, n: merged.length },
    time_to_merge_minutes: { mean: mean(minutesToMerge), median: median(minutesToMerge), n: minutesToMerge.length },
    runs_per_merged_pr: { mean: mean(runsToMerge), n: runsToMerge.length },
  };
}

/**
 * Of the tasks created in the window that have finished, how many did so
 * without a human: they never failed and never entered an attention state.
 * Cancelled work is an operator's choice, not an outcome, and is left out.
 */
export async function loadAutonomy(db: Knex, window: AnalyticsWindow | null): Promise<AutonomyMetrics> {
  const finishedStates = ['completed', 'failed'];
  const attention = [...ATTENTION_TASK_STATES];
  const query = db('tasks as t')
    .join(
      db('task_history').select('task_id').max('timestamp as max_ts').groupBy('task_id').as('latest'),
      't.task_id', 'latest.task_id',
    )
    .join('task_history as h', function (this: Knex.JoinClause) {
      this.on('h.task_id', '=', 't.task_id').andOn('h.timestamp', '=', 'latest.max_ts');
    })
    .whereIn('h.state', finishedStates)
    .select(db.raw(`count(distinct t.task_id) as finished`))
    .select(db.raw(`count(distinct CASE WHEN h.state = 'failed' OR EXISTS (
      SELECT 1 FROM task_history AS a WHERE a.task_id = t.task_id AND a.state IN (${attention.map(() => '?').join(', ')})
    ) THEN t.task_id END) as operator`, attention));
  whereCreatedWithin(query, 't.created_at', window);
  const row = await query.first() as { finished?: number | string; operator?: number | string } | undefined;
  const n = Number(row?.finished ?? 0);
  const operator = Number(row?.operator ?? 0);
  return { rate: n ? round((n - operator) / n, 4) : null, autonomous: n - operator, operator, n };
}
