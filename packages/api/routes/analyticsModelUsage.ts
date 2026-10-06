/**
 * The per-model breakdown behind the Analytics models table.
 */

import type { Knex } from 'knex';
import { whereCreatedWithin, type AnalyticsWindow } from './analyticsWindow.js';
import { withModelScoreFigures } from './reviewScoreStats.js';

interface ModelUsageRow {
  model_name: string | null;
  tasks?: number | string;
  cost?: number | string | null;
  tokens?: number | string | null;
}

export interface ModelUsage {
  model: string;
  tasks: number;
  tokens: number;
  cost_usd: number;
  /** Mean final review score of the PRs this model implemented; present when review scores are recorded. */
  mean_final_score?: number | null;
  /** Scored PRs behind `mean_final_score`. */
  n_scored?: number;
}

/**
 * Tasks, tokens and recorded cost for each model, most tasks first.
 *
 * Tasks are distinct tasks with at least one execution on the model, as in
 * the overview's `usage.models`; tokens and cost are summed over those
 * executions. A period bounds all three by when each execution started.
 * Each row also carries the review quality of the PRs the model implemented
 * (see `withModelScoreFigures`), bounded by when the scores were recorded.
 */
export async function loadModelUsage(db: Knex, analyticsWindow: AnalyticsWindow | null): Promise<ModelUsage[]> {
  const runsQuery = db('llm_executions')
    .select('model_name')
    .countDistinct('task_id as tasks')
    .sum('cost_usd as cost')
    .whereNotNull('model_name')
    .groupBy('model_name');
  whereCreatedWithin(runsQuery, 'start_time', analyticsWindow);

  const tokensQuery = db('llm_execution_details as d')
    .join('llm_executions as e', 'e.execution_id', 'd.execution_id')
    .select('e.model_name')
    .select(db.raw('sum(coalesce(d.token_count_input, 0) + coalesce(d.token_count_output, 0)) as tokens'))
    .whereNotNull('e.model_name')
    .groupBy('e.model_name');
  whereCreatedWithin(tokensQuery, 'e.start_time', analyticsWindow);

  const [runs, tokens] = await Promise.all([
    runsQuery as unknown as Promise<ModelUsageRow[]>,
    tokensQuery as unknown as Promise<ModelUsageRow[]>,
  ]);
  const tokensByModel = new Map(tokens.map(row => [row.model_name, Number(row.tokens || 0)]));
  const usage = runs
    .filter(row => row.model_name)
    .map(row => ({
      model: String(row.model_name),
      tasks: Number(row.tasks || 0),
      tokens: tokensByModel.get(row.model_name) ?? 0,
      cost_usd: Number(Number(row.cost || 0).toFixed(2)),
    }))
    .sort((left, right) => right.tasks - left.tasks || right.tokens - left.tokens || left.model.localeCompare(right.model));
  return withModelScoreFigures(db, analyticsWindow, usage);
}
