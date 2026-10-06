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
}

export interface ReviewScoreSummary {
  period: string | null;
  repository: string;
  prs_scored: number;
  scores_recorded: number;
  models: ReviewScoreModelSummary[];
}

export interface ReviewScoreQuery {
  period?: string;
  repository?: string;
}

/**
 * Per implementer model: PRs scored, first and final review scores, cycles to
 * the Ultrafix goal, merge rate and cost per merged PR.
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
