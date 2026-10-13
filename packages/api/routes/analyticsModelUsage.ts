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
  input_tokens?: number | string | null;
  output_tokens?: number | string | null;
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
 * Summed input and output tokens over the `llm_executions as e` rows a query
 * selects. Each execution's own totals are cache-inclusive for every provider
 * (cache reads and writes are part of `input_tokens`), and are what its cost
 * was priced from. Per-step detail rows carry each message's own usage, which
 * for Claude excludes cached input, so they only stand in for an execution
 * that recorded no totals.
 */
export function executionTokenSums(db: Knex): { input: Knex.Raw; output: Knex.Raw } {
  const sum = (executionColumn: string, detailColumn: string) => db.raw(`sum(coalesce(e.${executionColumn}, (
    select sum(d.${detailColumn}) from llm_execution_details d where d.execution_id = e.execution_id
  ), 0))`);
  return { input: sum('input_tokens', 'token_count_input'), output: sum('output_tokens', 'token_count_output') };
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
  const tokens = executionTokenSums(db);
  const runsQuery = db('llm_executions as e')
    .select(db.raw(`NULLIF(e.model_name, '') as model_name`))
    .count('* as runs')
    .countDistinct('e.task_id as tasks')
    .sum('e.cost_usd as cost')
    .select(db.raw('? as input_tokens', [tokens.input]), db.raw('? as output_tokens', [tokens.output]))
    .groupByRaw(`NULLIF(e.model_name, '')`);
  whereCreatedWithin(runsQuery, 'e.start_time', analyticsWindow);

  const runs = await runsQuery as unknown as ModelUsageRow[];
  const usage: ModelUsage[] = runs
    .map(row => ({
      model: row.model_name ?? null,
      runs: Number(row.runs || 0),
      tasks: Number(row.tasks || 0),
      tokens: Number(row.input_tokens || 0) + Number(row.output_tokens || 0),
      cost_usd: Number(Number(row.cost || 0).toFixed(2)),
    }))
    // The unknown row is listed last, whatever its size.
    .sort((left, right) => (left.model === null ? 1 : 0) - (right.model === null ? 1 : 0)
      || right.runs - left.runs || right.tokens - left.tokens || String(left.model).localeCompare(String(right.model)));
  return withModelScoreFigures(db, analyticsWindow, usage, cache);
}
