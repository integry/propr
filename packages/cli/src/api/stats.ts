/**
 * Stats API
 *
 * Read-only analytics from the ProPR backend's `/api/stats/*` endpoints.
 */

import { ApiClient, createApiClient } from "./index.js";

/** A mean with the number of pull requests behind it; null when unknown. */
export interface MeanFigure {
  mean: number | null;
  n: number;
}

/** Review quality of the pull requests one implementer model produced. */
export interface ReviewScoreModelSummary {
  implementer_model: string | null;
  implementer_agent: string | null;
  prs_scored: number;
  first_score: MeanFigure & { median: number | null };
  final_score: MeanFigure;
  cycles_to_goal: MeanFigure & { attempted: number };
  merge_rate: { value: number | null; merged: number; n: number };
  cost_per_merged_pr: { usd: number | null; n: number };
  /** Mean change from each PR's initial score to its final score. */
  score_delta: MeanFigure;
  /** Mean agent runs started at or before the merge, over merged PRs with recorded runs. */
  runs_to_merge: MeanFigure;
}

/** The same figures for one implementer model at one reasoning level (effort). */
export interface ReviewScoreEffortSummary extends ReviewScoreModelSummary {
  /** The implementation's recorded reasoning level, or `unknown` when none was recorded (historical data). */
  implementer_reasoning_level: string;
}

export interface ReviewScoreSummary {
  period: string | null;
  repository: string;
  prs_scored: number;
  scores_recorded: number;
  /** Per implementer model, over every effort. */
  models: ReviewScoreModelSummary[];
  /** Per implementer model and effort; absent from servers that predate it. */
  by_effort?: ReviewScoreEffortSummary[];
}

export interface ReviewScoreQuery {
  period?: string;
  repository?: string;
}

/**
 * Per implementer model, and per model and effort: PRs scored, first and final
 * review scores, cycles to the Ultrafix goal, merge rate, runs to merge and
 * cost per merged PR.
 */
export async function getReviewScoreSummary(query: ReviewScoreQuery = {}, client?: ApiClient): Promise<ReviewScoreSummary> {
  const apiClient = client ?? (await createApiClient());
  const params = new URLSearchParams();
  if (query.period) params.set("period", query.period);
  if (query.repository) params.set("repository", query.repository);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await apiClient.get<ReviewScoreSummary>(`/api/stats/review-scores${suffix}`);
  return response.data;
}

/** Dimensions `/api/stats/cost` groups by, in column order. */
export const COST_GROUP_KEYS = ["day", "repository", "agent", "model", "reasoning_level", "execution_type", "outcome"] as const;
export type CostGroupKey = typeof COST_GROUP_KEYS[number];

/** Executions, tasks, tokens and recorded cost of one group, or of the whole export. */
export interface CostFigures {
  executions: number;
  tasks: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Null when no execution in the group recorded a cost. */
  cost_usd: number | null;
}

export type CostRow = Partial<Record<CostGroupKey, string | null>> & CostFigures;

export interface CostExport {
  period: string | null;
  repository: string;
  group_by: CostGroupKey[];
  rows: CostRow[];
  totals: CostFigures;
}

export interface CostExportQuery {
  period?: string;
  repository?: string;
  /** Dimensions to group by; the server's default (`day`) when omitted. */
  groupBy?: string[];
}

function costExportPath(path: string, query: CostExportQuery): string {
  const params = new URLSearchParams();
  if (query.period) params.set("period", query.period);
  if (query.repository) params.set("repository", query.repository);
  if (query.groupBy) params.set("group_by", query.groupBy.join(","));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `${path}${suffix}`;
}

/** Recorded LLM executions grouped by the requested dimensions, with totals. */
export async function getCostExport(query: CostExportQuery = {}, client?: ApiClient): Promise<CostExport> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<CostExport>(costExportPath("/api/stats/cost", query));
  return response.data;
}

/** The same export as CSV, exactly as the server renders it. */
export async function getCostExportCsv(query: CostExportQuery = {}, client?: ApiClient): Promise<string> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<string>(costExportPath("/api/stats/cost.csv", query));
  return response.data;
}
