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
