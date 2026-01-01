// Task Statistics Types and API
import { API_BASE_URL, handleApiResponse } from './gitfixApi';

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

export const getTaskStats = async (): Promise<TaskStatsResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/stats/tasks`, {
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

export const getRepositoryStats = async (): Promise<RepositoryStatsResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/stats/repositories`, {
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
  total_cost_usd: number;
  models: Record<string, number>;
}

export interface StatsOverviewSystem {
  repos_indexed: number;
}

export interface StatsOverviewResponse {
  tasks: StatsOverviewTasks;
  usage: StatsOverviewUsage;
  system: StatsOverviewSystem;
}

export const getStatsOverview = async (): Promise<StatsOverviewResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/stats/overview`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
