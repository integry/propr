// Task Statistics Types and API
import type { AnalyticsTimeframe } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/** Without a period each endpoint keeps its historical scope. */
const periodQuery = (period?: AnalyticsTimeframe): string =>
  period ? `?period=${encodeURIComponent(period)}` : '';

export interface DailyCount {
  date: string;
  count: number;
}

export interface StatusDistribution {
  status: string;
  count: number;
}

export interface AvgProcessingTime {
  date: string;
  avgMinutes: number;
}

export interface TaskStatsSummary {
  total: number;
  completed: number;
  failed: number;
}

export interface TaskStatsResponse {
  dailyCounts: DailyCount[];
  statusDistribution: StatusDistribution[];
  avgProcessingTime: AvgProcessingTime[];
  summary: TaskStatsSummary;
}

export const getTaskStats = async (period?: AnalyticsTimeframe): Promise<TaskStatsResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/stats/tasks${periodQuery(period)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

// Repository Statistics Types and API
export interface RepositoryStats {
  repository: string;
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  successRate: number;
}

export interface RepositoryStatsResponse {
  repositories: RepositoryStats[];
}

export const getRepositoryStats = async (period?: AnalyticsTimeframe): Promise<RepositoryStatsResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/stats/repositories${periodQuery(period)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

// Stats Overview Types and API
export interface StatsOverviewTasks {
  completed: number;
  planned: number;
  pr_iterations_avg: number;
  merged_prs: number;
  total_followups: number;
}

export interface StatsOverviewUsage {
  total_tokens: number;
  /** Prompt and completion tokens; absent from servers that predate the split. */
  input_tokens?: number;
  output_tokens?: number;
  total_cost_usd: number;
  models: Record<string, number>;
}

export interface StatsOverviewSystem {
  repos_indexed: number;
}

/** One model's share of the period: distinct tasks, tokens and recorded cost. */
export interface StatsOverviewModelUsage {
  model: string;
  tasks: number;
  tokens: number;
  cost_usd: number;
  /** Mean final review score of PRs this model implemented; absent from servers without review scores. */
  mean_final_score?: number | null;
  n_scored?: number;
}

export interface StatsOverviewResponse {
  tasks: StatsOverviewTasks;
  usage: StatsOverviewUsage;
  /** Absent from servers that predate the per-model breakdown. */
  model_usage?: StatsOverviewModelUsage[];
  system: StatsOverviewSystem;
}

export const getStatsOverview = async (period?: AnalyticsTimeframe): Promise<StatsOverviewResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/stats/overview${periodQuery(period)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

// Review Scores Types and API

/** A mean over `n` pull requests; null when there is nothing to average. */
export interface ReviewScoreMean {
  mean: number | null;
  n: number;
}

/** Review quality of the pull requests one implementer model produced. */
export interface ReviewScoreModelSummary {
  implementer_model: string | null;
  implementer_agent: string | null;
  prs_scored: number;
  first_score: ReviewScoreMean & { median: number | null };
  final_score: ReviewScoreMean;
  cycles_to_goal: ReviewScoreMean & { attempted: number };
  merge_rate: { value: number | null; merged: number; n: number };
  cost_per_merged_pr: { usd: number | null; n: number };
}

export interface ReviewScoreSummaryResponse {
  period: string | null;
  repository: string;
  prs_scored: number;
  scores_recorded: number;
  models: ReviewScoreModelSummary[];
}

export const getReviewScoreSummary = async (period?: AnalyticsTimeframe): Promise<ReviewScoreSummaryResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/stats/review-scores${periodQuery(period)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface PullRequestScore {
  cycle_number: number | null;
  source: 'review' | 'ultrafix';
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
}

export interface PullRequestScoresResponse {
  repository: string;
  pr_number: number;
  outcome: 'merged' | 'closed' | null;
  merged_at: string | null;
  closed_at: string | null;
  scores: PullRequestScore[];
}

export const getPullRequestScores = async (repository: string, prNumber: number): Promise<PullRequestScoresResponse> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/pull-requests/${encodeURIComponent(String(prNumber))}/scores?repository=${encodeURIComponent(repository)}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' },
  );
  await handleApiResponse(response);
  return response.json();
};

// Generating Plans Count Types and API
export interface GeneratingPlansCountResponse {
  count: number;
}

export const getGeneratingPlansCount = async (): Promise<GeneratingPlansCountResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/stats/generating-plans`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
