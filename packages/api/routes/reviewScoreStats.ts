/**
 * Review quality by implementer model, from persisted review scores.
 *
 * A pull request is the unit: its scores are grouped, ordered, and joined with
 * its recorded outcome (`notification_pull_request_state`) and with the
 * recorded cost of every task attached to it. Each figure carries its own
 * denominator `n`, and a figure with no data is null, never 0.
 */

import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { readAnalyticsWindow, whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { validateRepository, validateRepositoryFilter } from './validation.js';

/** Task types that act on an existing PR, as in the dashboard's PR identity. */
const PULL_REQUEST_TASK_TYPES = ['pr-comment', 'review', 'merge_conflict'] as const;

interface ScoreRow {
  id: number;
  repository_id: string;
  pr_number: number;
  implementer_model: string | null;
  implementer_agent: string | null;
  score: number;
  blocker_count: number;
  cycle_number: number | null;
  goal: number | null;
  created_at: string;
}

interface OutcomeRow {
  repository: string;
  pr_number: number;
  outcome: string | null;
  merged_at: string | null;
}

interface CostRow {
  repository: string;
  pull_request_number: number | null;
  cost: number | string | null;
  costed: number | string;
}

export interface MeanFigure { mean: number | null; n: number }
export interface ReviewScoreModelSummary {
  implementer_model: string | null;
  implementer_agent: string | null;
  /** Pull requests with at least one score in the period. */
  prs_scored: number;
  first_score: MeanFigure & { median: number | null };
  /** Last score before merge; the latest score for a PR that was not merged. */
  final_score: MeanFigure;
  /** Ultrafix cycles until a clean review met the goal; n counts PRs that reached it. */
  cycles_to_goal: MeanFigure & { attempted: number };
  /** Merged over merged-or-closed; open PRs have no outcome yet. */
  merge_rate: { value: number | null; merged: number; n: number };
  /** Recorded cost of merged PRs' implementation and follow-up tasks; n counts merged PRs with recorded cost. */
  cost_per_merged_pr: { usd: number | null; n: number };
}

export interface ReviewScoreSummary {
  period: string | null;
  repository: string;
  prs_scored: number;
  scores_recorded: number;
  models: ReviewScoreModelSummary[];
}

interface PullRequestFacts {
  model: string | null;
  agent: string | null;
  first: number;
  final: number;
  cyclesToGoal: number | null;
  hadGoal: boolean;
  outcome: 'merged' | 'closed' | null;
  cost: number | null;
}

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));
const mean = (values: number[]): number | null =>
  values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2);
}

const prKey = (repository: string, prNumber: number | string): string => `${repository}#${Number(prNumber)}`;

function cyclesToGoal(rows: ScoreRow[]): { hadGoal: boolean; cycles: number | null } {
  const goalRows = rows.filter(row => row.goal !== null && row.goal !== undefined);
  if (!goalRows.length) return { hadGoal: false, cycles: null };
  const index = goalRows.findIndex(row => row.blocker_count === 0 && row.score >= Number(row.goal));
  if (index < 0) return { hadGoal: true, cycles: null };
  return { hadGoal: true, cycles: goalRows[index].cycle_number ?? index + 1 };
}

/** Recorded cost per pull request: its implementation task plus every task acting on it. */
async function loadPullRequestCosts(db: Knex, repositories: string[]): Promise<Map<string, number>> {
  if (!repositories.length) return new Map();
  const types = PULL_REQUEST_TASK_TYPES.map(() => '?').join(', ');
  const rows = await db('llm_executions as e')
    .join('tasks as t', 't.task_id', 'e.task_id')
    .whereIn('t.repository', repositories)
    .select('t.repository')
    .select(db.raw(`COALESCE(t.pr_number,
      CASE WHEN t.task_type IN (${types}) OR substr(t.task_id, 1, 10) = 'pr-comment' THEN t.issue_number END) AS pull_request_number`,
    [...PULL_REQUEST_TASK_TYPES]))
    .sum('e.cost_usd as cost')
    .count('e.cost_usd as costed')
    .groupBy('t.repository', 'pull_request_number') as unknown as CostRow[];
  const costs = new Map<string, number>();
  for (const row of rows) {
    if (row.pull_request_number === null || Number(row.costed) === 0) continue;
    costs.set(prKey(row.repository, row.pull_request_number), Number(row.cost || 0));
  }
  return costs;
}

async function loadOutcomes(db: Knex, repositories: string[]): Promise<Map<string, OutcomeRow>> {
  if (!repositories.length) return new Map();
  const rows = await db('notification_pull_request_state')
    .whereIn('repository', repositories)
    .select('repository', 'pr_number', 'outcome', 'merged_at') as OutcomeRow[];
  return new Map(rows.map(row => [prKey(row.repository, row.pr_number), row]));
}

function pullRequestFacts(rows: ScoreRow[], outcome: OutcomeRow | undefined, cost: number | null): PullRequestFacts {
  const mergedAt = outcome?.merged_at ?? null;
  const state = outcome?.outcome === 'merged' || mergedAt ? 'merged' : outcome?.outcome === 'closed' ? 'closed' : null;
  const beforeMerge = state === 'merged' && mergedAt ? rows.filter(row => row.created_at <= mergedAt) : [];
  const final = (beforeMerge.length ? beforeMerge : rows).at(-1)!;
  const attributed = [...rows].reverse().find(row => row.implementer_model);
  const goal = cyclesToGoal(rows);
  return {
    model: attributed?.implementer_model ?? null,
    agent: attributed?.implementer_agent ?? null,
    first: rows[0].score,
    final: final.score,
    cyclesToGoal: goal.cycles,
    hadGoal: goal.hadGoal,
    outcome: state,
    cost: state === 'merged' ? cost : null,
  };
}

function summarizeModel(model: string | null, prs: PullRequestFacts[]): ReviewScoreModelSummary {
  const firsts = prs.map(pr => pr.first);
  const cycles = prs.flatMap(pr => pr.cyclesToGoal === null ? [] : [pr.cyclesToGoal]);
  const resolved = prs.filter(pr => pr.outcome !== null);
  const merged = resolved.filter(pr => pr.outcome === 'merged');
  const costs = merged.flatMap(pr => pr.cost === null ? [] : [pr.cost]);
  const agents = [...new Set(prs.flatMap(pr => pr.agent ? [pr.agent] : []))];
  return {
    implementer_model: model,
    implementer_agent: agents.length === 1 ? agents[0] : null,
    prs_scored: prs.length,
    first_score: { mean: mean(firsts), median: median(firsts), n: firsts.length },
    final_score: { mean: mean(prs.map(pr => pr.final)), n: prs.length },
    cycles_to_goal: { mean: mean(cycles), n: cycles.length, attempted: prs.filter(pr => pr.hadGoal).length },
    merge_rate: { value: resolved.length ? round(merged.length / resolved.length, 4) : null, merged: merged.length, n: resolved.length },
    cost_per_merged_pr: {
      usd: costs.length ? round(costs.reduce((sum, cost) => sum + cost, 0) / costs.length, 4) : null,
      n: costs.length,
    },
  };
}

/** Per implementer model, the review quality of PRs scored in the window. */
export async function loadReviewScoreSummary(
  db: Knex, analyticsWindow: AnalyticsWindow | null, repository = 'all',
): Promise<ReviewScoreSummary> {
  const query = db('review_scores')
    .select('id', 'repository_id', 'pr_number', 'implementer_model', 'implementer_agent', 'score',
      'blocker_count', 'cycle_number', 'goal', 'created_at')
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]);
  if (repository !== 'all') query.where('repository_id', repository);
  whereCreatedWithin(query, 'created_at', analyticsWindow);
  const rows = await query as ScoreRow[];

  const byPullRequest = new Map<string, ScoreRow[]>();
  for (const row of rows) {
    const key = prKey(row.repository_id, row.pr_number);
    byPullRequest.set(key, [...(byPullRequest.get(key) ?? []), row]);
  }
  const repositories = [...new Set(rows.map(row => row.repository_id))];
  const [outcomes, costs] = await Promise.all([loadOutcomes(db, repositories), loadPullRequestCosts(db, repositories)]);

  const byModel = new Map<string | null, PullRequestFacts[]>();
  for (const [key, prRows] of byPullRequest) {
    const facts = pullRequestFacts(prRows, outcomes.get(key), costs.get(key) ?? null);
    byModel.set(facts.model, [...(byModel.get(facts.model) ?? []), facts]);
  }
  const models = [...byModel].map(([model, prs]) => summarizeModel(model, prs))
    .sort((left, right) => right.prs_scored - left.prs_scored
      || (left.implementer_model === null ? 1 : right.implementer_model === null ? -1 : left.implementer_model.localeCompare(right.implementer_model)));
  return {
    period: analyticsWindow?.timeframe ?? null,
    repository,
    prs_scored: byPullRequest.size,
    scores_recorded: rows.length,
    models,
  };
}

/**
 * The overview's model rows, each with the mean final review score and the
 * number of scored PRs it implemented. Review scores join by implementer
 * model; a model with no scored PR has no mean. Unchanged when the instance
 * has no score table.
 */
export async function withModelScoreFigures<T extends { model: string }>(
  db: Knex, analyticsWindow: AnalyticsWindow | null, modelUsage: T[],
): Promise<Array<T | T & { mean_final_score: number | null; n_scored: number }>> {
  if (!await db.schema.hasTable('review_scores')) return modelUsage;
  const summary = await loadReviewScoreSummary(db, analyticsWindow);
  const figures = new Map(summary.models.map(model => [model.implementer_model, model.final_score]));
  return modelUsage.map(entry => {
    const final = figures.get(entry.model);
    return { ...entry, mean_final_score: final?.mean ?? null, n_scored: final?.n ?? 0 };
  });
}

const CSV_COLUMNS: Array<[string, (model: ReviewScoreModelSummary) => string | number | null]> = [
  ['implementer_model', model => model.implementer_model],
  ['implementer_agent', model => model.implementer_agent],
  ['prs_scored', model => model.prs_scored],
  ['first_score_mean', model => model.first_score.mean],
  ['first_score_median', model => model.first_score.median],
  ['first_score_n', model => model.first_score.n],
  ['final_score_mean', model => model.final_score.mean],
  ['final_score_n', model => model.final_score.n],
  ['cycles_to_goal_mean', model => model.cycles_to_goal.mean],
  ['cycles_to_goal_n', model => model.cycles_to_goal.n],
  ['cycles_to_goal_attempted', model => model.cycles_to_goal.attempted],
  ['merge_rate', model => model.merge_rate.value],
  ['merged', model => model.merge_rate.merged],
  ['merge_rate_n', model => model.merge_rate.n],
  ['cost_per_merged_pr_usd', model => model.cost_per_merged_pr.usd],
  ['cost_per_merged_pr_n', model => model.cost_per_merged_pr.n],
];

/** RFC 4180 cell; unknown is an empty cell, and text cannot start a spreadsheet formula. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function reviewScoreSummaryCsv(summary: ReviewScoreSummary): string {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const model of summary.models) lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(model))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export interface PullRequestScoreHistory {
  repository: string;
  pr_number: number;
  outcome: 'merged' | 'closed' | null;
  merged_at: string | null;
  closed_at: string | null;
  scores: Array<{
    cycle_number: number | null;
    source: string;
    score: number;
    goal: number | null;
    blocker_count: number;
    suggestion_count: number;
    reviewer_agent: string | null;
    reviewer_model: string | null;
    implementer_model: string | null;
    head_sha: string | null;
    task_id: string;
    created_at: string;
  }>;
}

/** One PR's scores, oldest first, with its recorded outcome. */
export async function loadPullRequestScores(db: Knex, repository: string, prNumber: number): Promise<PullRequestScoreHistory> {
  const [scores, state] = await Promise.all([
    db('review_scores').where({ repository_id: repository, pr_number: prNumber })
      .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
      .select('cycle_number', 'source', 'score', 'goal', 'blocker_count', 'suggestion_count', 'reviewer_agent',
        'reviewer_model', 'implementer_model', 'head_sha', 'task_id', 'created_at') as Promise<PullRequestScoreHistory['scores']>,
    db('notification_pull_request_state').where({ repository, pr_number: prNumber })
      .select('outcome', 'merged_at', 'closed_at').first() as Promise<{ outcome: string | null; merged_at: string | null; closed_at: string | null } | undefined>,
  ]);
  const outcome = state?.outcome === 'merged' || state?.merged_at ? 'merged' : state?.outcome === 'closed' ? 'closed' : null;
  return { repository, pr_number: prNumber, outcome, merged_at: state?.merged_at ?? null, closed_at: state?.closed_at ?? null, scores };
}

interface ReviewScoreRoutesDeps {
  db: Knex;
  now?: () => Date;
}

export function createReviewScoreRoutes({ db, now = () => new Date() }: ReviewScoreRoutesDeps) {
  async function readSummary(req: Request, res: Response): Promise<ReviewScoreSummary | null> {
    const analyticsWindow = readAnalyticsWindow(req, res, now());
    if (analyticsWindow === false) return null;
    const repository = typeof req.query.repository === 'string' && req.query.repository ? req.query.repository : 'all';
    const validation = validateRepositoryFilter(repository);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return null;
    }
    return await loadReviewScoreSummary(db, analyticsWindow, repository === 'all' ? 'all' : repository.trim());
  }

  async function getSummary(req: Request, res: Response): Promise<void> {
    try {
      const summary = await readSummary(req, res);
      if (summary) res.json(summary);
    } catch (error) {
      console.error('Error in /api/stats/review-scores:', error);
      res.status(500).json({ error: 'Failed to fetch review score statistics' });
    }
  }

  async function getCsv(req: Request, res: Response): Promise<void> {
    try {
      const summary = await readSummary(req, res);
      if (!summary) return;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="review-scores-${summary.period ?? 'all'}.csv"`);
      res.send(reviewScoreSummaryCsv(summary));
    } catch (error) {
      console.error('Error in /api/stats/review-scores.csv:', error);
      res.status(500).json({ error: 'Failed to export review score statistics' });
    }
  }

  async function getPullRequestScores(req: Request, res: Response): Promise<void> {
    const prNumber = Number(req.params.number);
    if (!/^\d+$/.test(String(req.params.number)) || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      res.status(400).json({ error: 'Pull request number must be a positive integer' });
      return;
    }
    const validation = validateRepository(req.query.repository);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const repository = String(req.query.repository).trim();
    try {
      res.json(await loadPullRequestScores(db, repository, prNumber));
    } catch (error) {
      console.error('Error in /api/pull-requests/:number/scores:', error);
      res.status(500).json({ error: 'Failed to fetch pull request scores' });
    }
  }

  return { getSummary, getCsv, getPullRequestScores };
}
