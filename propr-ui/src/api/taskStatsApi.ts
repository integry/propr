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
