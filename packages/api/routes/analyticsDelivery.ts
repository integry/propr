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
 * A merged PR is judged by the work it took to reach the merge: tasks created,
 * runs started and Ultrafix cycles scored after its recorded merge time are
 * left out, so later work on the same issue never rewrites its verdict.
 *
 * Every figure carries its denominator, and a figure with nothing behind it is
 * null, never 0.
 */

import type { Knex } from 'knex';
import { whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { ATTENTION_TASK_STATES, chunk } from './dashboardQueries.js';
import { isPullRequestTask } from './pullRequestTaskIdentity.js';
import { hasColumn, hasTable } from './analyticsSchema.js';
import { excludeGoalTasks } from './analyticsAggregates.js';

export interface DeliveryMetrics {
  /** Pull requests opened by tasks created in the window. */
  prs_opened: number;
  prs_merged: number;
  prs_closed: number;
  /**
   * Merged PRs that needed no fix: one implementation task for their issue, no
   * follow-up fix task on the PR (Ultrafix's included; a review or a
   * merge-conflict resolution is not a fix) and no Ultrafix fix cycle. n is
   * merged PRs.
   */
  first_time_pass: { rate: number | null; passed: number; n: number };
  /** Wall-clock minutes from the issue's first task to the merge. n is merged PRs with a merge time. */
  time_to_merge_minutes: { mean: number | null; median: number | null; n: number };
  /** Agent executions across each merged PR's tasks, started at or before its merge. */
  runs_per_merged_pr: { mean: number | null; n: number };
}

export interface AutonomyMetrics {
  /** Share of finished tasks that never needed an operator, 0–1. */
  rate: number | null;
  autonomous: number;
  /** Finished tasks that failed or asked for a human at any point. */
  operator: number;
  /** Finished tasks created in the window, goal tasks aside: never more than the page's Total tasks. */
  n: number;
}

export interface TaskRow {
  task_id: string;
  repository: string;
  issue_number: number | null;
  pr_number: number | null;
  task_type: string | null;
  created_at: string;
  /** `initial_job_data.commandMode`, when the schema records job data. */
  command_mode?: string | null;
}

export interface PullRequest {
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

/** Whether a timestamp falls at or before a merge; with no recorded merge time there is no cutoff. */
const atOrBefore = (value: string | Date, mergedAt: string | null): boolean =>
  mergedAt === null || toTime(value) <= toTime(mergedAt);

/**
 * Any task acting on a PR is a fix unless it only reviews, or only resolves a
 * merge conflict. An Ultrafix loop's fix step is a fix like any other: the
 * task itself is the evidence, whether or not a later review of the fixed
 * code was ever scored. A merge-conflict resolution replays the same change
 * onto a base that moved underneath it; nothing about the change was found
 * wanting, so it does not cost the PR its first-time pass.
 */
function isFixTask(task: TaskRow): boolean {
  return task.task_type !== 'review' && task.task_type !== 'merge_conflict' && task.command_mode !== 'review';
}

async function loadOutcomes(db: Knex, pullRequests: PullRequest[]): Promise<Map<string, { merged_at: string | null; outcome: string | null }>> {
  const outcomes = new Map<string, { merged_at: string | null; outcome: string | null }>();
  if (!pullRequests.length || !await hasTable(db, 'notification_pull_request_state')) return outcomes;
  const hasOutcome = await hasColumn(db, 'notification_pull_request_state', 'outcome');
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

/**
 * When each PR's Ultrafix loop first recorded a scored cycle after the first,
 * which only a fix leads to. Supporting evidence: a fix whose next review was
 * never scored is still found by its task.
 */
async function loadUltrafixFixTimes(db: Knex, pullRequests: PullRequest[]): Promise<Map<string, string>> {
  const fixed = new Map<string, string>();
  if (!pullRequests.length || !await hasTable(db, 'review_scores')) return fixed;
  const repositories = [...new Set(pullRequests.map(pr => pr.repository))];
  for (const numbers of chunk([...new Set(pullRequests.map(pr => pr.prNumber))])) {
    const rows = await db('review_scores')
      .whereIn('repository_id', repositories)
      .whereIn('pr_number', numbers)
      .where('source', 'ultrafix')
      .where('cycle_number', '>', 1)
      .select('repository_id', 'pr_number')
      .min('created_at as first_at')
      .groupBy('repository_id', 'pr_number') as Array<{ repository_id: string; pr_number: number; first_at: string }>;
    for (const row of rows) fixed.set(prKey(row.repository_id, row.pr_number), row.first_at);
  }
  return fixed;
}

const TASK_COLUMNS = ['task_id', 'repository', 'issue_number', 'pr_number', 'task_type', 'created_at'];

/**
 * Task columns to read. Of the job data only the command mode is read, to tell
 * reviews apart, rather than every task's whole JSON; a schema without job
 * data reads every follow-up as a fix.
 *
 * `json_valid` and `json_extract` are SQLite's JSON1 functions. ProPR's task
 * store is SQLite, as every analytics query here assumes; another Knex
 * dialect would need its own JSON path expression.
 */
export async function taskColumns(db: Knex): Promise<Array<string | Knex.Raw>> {
  if (!await hasColumn(db, 'tasks', 'initial_job_data')) return TASK_COLUMNS;
  return [...TASK_COLUMNS, db.raw(
    `CASE WHEN json_valid(initial_job_data) THEN json_extract(initial_job_data, '$.commandMode') END AS command_mode`,
  )];
}

/**
 * Numbers per related-task query. Each batch is bound twice (issue and PR
 * number) beside the repositories, so half the usual batch keeps the query
 * under SQLite's historical limit of 999 bound parameters.
 */
const RELATED_BATCH_SIZE = 250;

/**
 * Every task in the given repositories that names one of the numbers, by issue
 * or PR, once each: a task whose issue and PR numbers fall in different
 * batches is matched by both.
 */
export async function loadRelatedTasks(
  db: Knex, repositories: string[], numbers: number[], columns: Array<string | Knex.Raw>,
): Promise<TaskRow[]> {
  const rows = new Map<string, TaskRow>();
  for (const batch of chunk(numbers, RELATED_BATCH_SIZE)) {
    const matched = await db('tasks')
      .whereIn('repository', repositories)
      .where(function (this: Knex.QueryBuilder) {
        this.whereIn('issue_number', batch).orWhereIn('pr_number', batch);
      })
      .select(columns) as TaskRow[];
    for (const task of matched) rows.set(task.task_id, task);
  }
  return [...rows.values()];
}

/** One task's runs counted toward one merged PR, up to that PR's merge time. */
export interface RunEvidence { key: string; taskId: string; mergedAt: string | null }

/**
 * Executions per merged PR across its tasks, counting only runs started at or
 * before the PR's merge. A task can belong to two PRs with different merge
 * times (two PRs for one issue), so the cutoff travels with each pairing.
 *
 * The pairings are bound as a `VALUES` common table expression, SQLite's
 * form of a row-value list; like `taskColumns`, this assumes the SQLite task
 * store rather than any Knex dialect.
 */
export async function loadRunsToMerge(db: Knex, evidence: RunEvidence[]): Promise<Map<string, number>> {
  const runs = new Map<string, number>();
  // Three bindings per pairing keep each batch under 999 bound parameters.
  for (const batch of chunk(evidence, 300)) {
    const rows = await db.raw(
      `WITH evidence(pr_key, task_id, cutoff) AS (VALUES ${batch.map(() => '(?, ?, ?)').join(', ')})
       SELECT evidence.pr_key AS pr_key, count(*) AS runs
       FROM evidence JOIN llm_executions AS e ON e.task_id = evidence.task_id
       WHERE evidence.cutoff IS NULL OR e.start_time <= evidence.cutoff
       GROUP BY evidence.pr_key`,
      batch.flatMap(item => [item.key, item.taskId, item.mergedAt]),
    ) as Array<{ pr_key: string; runs: number | string }>;
    for (const row of rows) runs.set(row.pr_key, (runs.get(row.pr_key) ?? 0) + Number(row.runs));
  }
  return runs;
}

/** Related tasks keyed by repository and every number they name, issue or PR. */
export function indexRelatedTasks(related: TaskRow[]): Map<string, TaskRow[]> {
  const index = new Map<string, TaskRow[]>();
  for (const task of related) {
    const keys = new Set([task.issue_number, task.pr_number].flatMap(number => number === null ? [] : [prKey(task.repository, number)]));
    for (const key of keys) index.set(key, [...(index.get(key) ?? []), task]);
  }
  return index;
}

export interface MergedPullRequestEvidence {
  implementations: TaskRow[];
  followUps: TaskRow[];
}

/** Whether a task is an implementation attempt at a PR: one that opened it, or any other attempt at its issue. */
export function isImplementationAttempt(task: TaskRow, pr: PullRequest): boolean {
  return !isPullRequestTask(task) && task.task_type !== 'goal'
    && (Number(task.pr_number) === pr.prNumber || (pr.issueNumber !== null && Number(task.issue_number) === pr.issueNumber));
}

/**
 * Every task attached to one PR over its whole history: its implementation
 * attempts — the task that opened it and every other task on its issue, an
 * attempt that opened no PR included — and the follow-ups acting on the PR
 * itself. A goal task names the issue it works toward but opens no PR, so it
 * is never an implementation attempt. Review quality's cost and runs to merge
 * read the same attachment, so the two pages count one PR's work alike.
 */
export function attachedTasks(pr: PullRequest, index: Map<string, TaskRow[]>): MergedPullRequestEvidence {
  const candidates = new Map<string, TaskRow>();
  for (const number of pr.issueNumber === null ? [pr.prNumber] : [pr.prNumber, pr.issueNumber]) {
    for (const task of index.get(prKey(pr.repository, number)) ?? []) candidates.set(task.task_id, task);
  }
  const attached = [...candidates.values()];
  return {
    implementations: attached.filter(task => isImplementationAttempt(task, pr)),
    followUps: attached.filter(task => isPullRequestTask(task) && Number(task.issue_number) === pr.prNumber),
  };
}

/**
 * The tasks that took one merged PR to its merge: its attached tasks created
 * at or before the merge.
 */
function mergedPullRequestEvidence(pr: PullRequest & { mergedAt: string | null }, index: Map<string, TaskRow[]>): MergedPullRequestEvidence {
  const { implementations, followUps } = attachedTasks(pr, index);
  return {
    implementations: implementations.filter(task => atOrBefore(task.created_at, pr.mergedAt)),
    followUps: followUps.filter(task => atOrBefore(task.created_at, pr.mergedAt)),
  };
}

interface MergedPullRequest {
  firstTimePass: boolean;
  runs: number;
  /** Null when the merge time or the submission is unknown. */
  minutesToMerge: number | null;
}

/** How one merged PR got there, from the evidence recorded up to its merge. */
function mergedPullRequestFacts(
  pr: { mergedAt: string | null; ultrafixFixed: boolean }, evidence: MergedPullRequestEvidence, runs: number,
): MergedPullRequest {
  const { mergedAt, ultrafixFixed } = pr;
  const { implementations, followUps } = evidence;

  let minutesToMerge: number | null = null;
  if (mergedAt && implementations.length) {
    const minutes = (toTime(mergedAt) - Math.min(...implementations.map(task => toTime(task.created_at)))) / 60_000;
    if (Number.isFinite(minutes) && minutes >= 0) minutesToMerge = minutes;
  }
  // Runs on the one implementation task are not counted against it: a task
  // can record several (auxiliary calls, a usage-limit requeue), and any run
  // that fixed the PR belongs to a follow-up task, judged by isFixTask.
  return {
    firstTimePass: implementations.length <= 1 && !followUps.some(isFixTask) && !ultrafixFixed,
    runs,
    minutesToMerge,
  };
}

/** Pull requests opened by tasks created in the window, once each. */
async function loadOpenedPullRequests(db: Knex, window: AnalyticsWindow | null): Promise<Map<string, PullRequest>> {
  const query = db('tasks').whereNotNull('pr_number').select(TASK_COLUMNS);
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
  const pullRequests = await loadOpenedPullRequests(db, window);
  const prs = [...pullRequests.values()];
  const outcomes = await loadOutcomes(db, prs);

  let closed = 0;
  const mergedPullRequests = new Map<string, PullRequest & { mergedAt: string | null }>();
  for (const [key, pr] of pullRequests) {
    const outcome = outcomes.get(key);
    if (outcome?.outcome === 'merged' || outcome?.merged_at) {
      mergedPullRequests.set(key, { ...pr, mergedAt: outcome.merged_at });
    } else if (outcome?.outcome === 'closed') {
      closed += 1;
    }
  }

  // Only merged PRs are judged, so only their history is read.
  const mergedList = [...mergedPullRequests.values()];
  const repositories = [...new Set(mergedList.map(pr => pr.repository))];
  const numbers = [...new Set(mergedList.flatMap(pr => pr.issueNumber === null ? [pr.prNumber] : [pr.prNumber, pr.issueNumber]))];
  const [ultrafixFixTimes, related] = await Promise.all([
    loadUltrafixFixTimes(db, mergedList),
    repositories.length ? loadRelatedTasks(db, repositories, numbers, await taskColumns(db)) : Promise.resolve([] as TaskRow[]),
  ]);
  const index = indexRelatedTasks(related);
  const evidence = new Map([...mergedPullRequests].map(([key, pr]) => [key, mergedPullRequestEvidence(pr, index)]));
  const runs = await loadRunsToMerge(db, [...evidence].flatMap(([key, { implementations, followUps }]) =>
    [...implementations, ...followUps].map(task => ({ key, taskId: task.task_id, mergedAt: mergedPullRequests.get(key)!.mergedAt }))));

  const merged: MergedPullRequest[] = [...mergedPullRequests].map(([key, pr]) => {
    const fixedAt = ultrafixFixTimes.get(key);
    const ultrafixFixed = fixedAt !== undefined && atOrBefore(fixedAt, pr.mergedAt);
    return mergedPullRequestFacts({ mergedAt: pr.mergedAt, ultrafixFixed }, evidence.get(key)!, runs.get(key) ?? 0);
  });

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
 * A failure counts even when a retry later completed the task, as the
 * dashboard's own queries keep it. Cancelled work is an operator's choice,
 * not an outcome, and is left out. So are goal tasks, as the page's task
 * totals leave them out: a goal that finishes delivers nothing itself, and
 * counting it would let the share describe a population the page never shows.
 */
export async function loadAutonomy(db: Knex, window: AnalyticsWindow | null): Promise<AutonomyMetrics> {
  const finishedStates = ['completed', 'failed'];
  const operatorStates = ['failed', ...ATTENTION_TASK_STATES];
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
    .select(db.raw(`count(distinct CASE WHEN EXISTS (
      SELECT 1 FROM task_history AS a WHERE a.task_id = t.task_id AND a.state IN (${operatorStates.map(() => '?').join(', ')})
    ) THEN t.task_id END) as operator`, operatorStates));
  whereCreatedWithin(query, 't.created_at', window);
  excludeGoalTasks(query, 't.task_type');
  const row = await query.first() as { finished?: number | string; operator?: number | string } | undefined;
  const n = Number(row?.finished ?? 0);
  const operator = Number(row?.operator ?? 0);
  return { rate: n ? round((n - operator) / n, 4) : null, autonomous: n - operator, operator, n };
}
