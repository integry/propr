/**
 * The per-model breakdown behind the Analytics models table.
 */

import type { Knex } from 'knex';
import { whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { withModelScoreFigures } from './reviewScoreStats.js';
import type { AnalyticsCache } from './analyticsCache.js';

interface ModelUsageRow {
  model_name: string | null;
  runs?: number | string;
  tasks?: number | string;
  cost?: number | string | null;
  tokens?: number | string | null;
}

export interface ModelUsage {
  /**
   * The recorded model name; null for the executions that recorded none, kept
   * as one row so the table's runs still sum to every run in the period.
   */
  model: string | null;
  /** Agent executions on the model: the compute, not the deliverables. */
  runs: number;
  /** Distinct tasks with at least one execution on the model. */
  tasks: number;
  tokens: number;
  cost_usd: number;
  /** Mean final review score of the PRs this model implemented; present when review scores are recorded. */
  mean_final_score?: number | null;
  /** Scored PRs behind `mean_final_score`. */
  n_scored?: number;
}

/**
 * Runs, tasks, tokens and recorded cost for each model, most runs first.
 *
 * A run is one agent execution. A task usually takes several — implement,
 * review, fix — often on different models, so a model is credited with the
 * runs it executed rather than with whole tasks. Tasks are still reported as
 * distinct tasks with at least one execution on the model, as in the
 * overview's `usage.models`; tokens and cost are summed over the executions.
 * A period bounds every figure by when each execution started.
 * Executions without a model name are not dropped: they form one unknown-model
 * row, listed last, so the rows' runs reconcile with the delivery band's total
 * and the activity chart, which count every execution.
 * Each row also carries the review quality of the PRs the model implemented
 * (see `withModelScoreFigures`), bounded by when the scores were recorded;
 * with a cache, an all-time read of those scores is remembered for a while.
 */
export async function loadModelUsage(db: Knex, analyticsWindow: AnalyticsWindow | null, cache?: AnalyticsCache): Promise<ModelUsage[]> {
  // A null and an empty model name are both unknown, and group as one.
  const runsQuery = db('llm_executions')
    .select(db.raw(`NULLIF(model_name, '') as model_name`))
    .count('* as runs')
    .countDistinct('task_id as tasks')
    .sum('cost_usd as cost')
    .groupByRaw(`NULLIF(model_name, '')`);
  whereCreatedWithin(runsQuery, 'start_time', analyticsWindow);

  const tokensQuery = db('llm_execution_details as d')
    .join('llm_executions as e', 'e.execution_id', 'd.execution_id')
    .select(db.raw(`NULLIF(e.model_name, '') as model_name`))
    .select(db.raw('sum(coalesce(d.token_count_input, 0) + coalesce(d.token_count_output, 0)) as tokens'))
    .groupByRaw(`NULLIF(e.model_name, '')`);
  whereCreatedWithin(tokensQuery, 'e.start_time', analyticsWindow);

  const [runs, tokens] = await Promise.all([
    runsQuery as unknown as Promise<ModelUsageRow[]>,
    tokensQuery as unknown as Promise<ModelUsageRow[]>,
  ]);
  const tokensByModel = new Map(tokens.map(row => [row.model_name ?? null, Number(row.tokens || 0)]));
  const usage: ModelUsage[] = runs
    .map(row => ({
      model: row.model_name ?? null,
      runs: Number(row.runs || 0),
      tasks: Number(row.tasks || 0),
      tokens: tokensByModel.get(row.model_name ?? null) ?? 0,
      cost_usd: Number(Number(row.cost || 0).toFixed(2)),
    }))
    // The unknown row is listed last, whatever its size.
    .sort((left, right) => (left.model === null ? 1 : 0) - (right.model === null ? 1 : 0)
      || right.runs - left.runs || right.tokens - left.tokens || String(left.model).localeCompare(String(right.model)));
  return withModelScoreFigures(db, analyticsWindow, usage, cache);
}
