import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export type GoalState =
  | 'active'
  | 'pausing'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AutoMergePolicy = 'disabled' | 'approved' | 'all';

export type UltrafixMode = 'disabled' | 'enabled' | 'goal' | 'max_cycle';

export interface GoalListItem {
  id: string;
  objective: string;
  repository: string;
  state: GoalState;
  agentAlias: string;
  requestedModel: string;
  effectiveModel?: string;
  maxConcurrentTasks: number;
  autoMergePolicy: AutoMergePolicy;
  ultrafixMode: UltrafixMode;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
  // Hierarchy/checklist
  checklistTotal: number;
  checklistCompleted: number;
  activeTasks: number;
  // Issues
  issuesProcessed: number;
  issuesActive: number;
  issuesFailed: number;
  issuesBlocked: number;
  // Resource usage
  tokenTotal: number;
  elapsedSeconds: number;
  pausedSeconds: number;
  // Links and events
  latestEvent?: string;
  epicPrUrl?: string;
  connectionState?: 'connected' | 'recovering' | 'disconnected';
  createdAt: string;
  updatedAt: string;
}

export interface GoalsListResponse {
  goals: GoalListItem[];
  total: number;
  hasMore: boolean;
}

export interface GetGoalsOptions {
  page?: number;
  limit?: number;
  state?: GoalState | 'all';
  repository?: string;
  search?: string;
}

export interface CreateGoalParams {
  objective: string;
  repository: string;
  agentAlias: string;
  model: string;
  maxConcurrentTasks: number;
  autoMergePolicy: AutoMergePolicy;
  ultrafixMode: UltrafixMode;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
}

export const getGoals = async (options: GetGoalsOptions = {}): Promise<GoalsListResponse> => {
  const params = new URLSearchParams();
  if (options.page) params.set('page', String(options.page));
  if (options.limit) params.set('limit', String(options.limit));
  if (options.state && options.state !== 'all') params.set('state', options.state);
  if (options.repository) params.set('repository', options.repository);
  if (options.search) params.set('search', options.search);

  const response = await apiFetch(
    `${API_BASE_URL}/api/goals?${params.toString()}`,
    { credentials: 'include' }
  );
  await handleApiResponse(response);
  return response.json() as Promise<GoalsListResponse>;
};

export const createGoal = async (params: CreateGoalParams): Promise<GoalListItem> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      credentials: 'include',
    },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleApiResponse(response);
  return response.json() as Promise<GoalListItem>;
};

export const getGoal = async (goalId: string): Promise<GoalListItem> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${goalId}`,
    { credentials: 'include' }
  );
  await handleApiResponse(response);
  return response.json() as Promise<GoalListItem>;
};

export const pauseGoal = async (goalId: string): Promise<GoalListItem> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${goalId}/pause`,
    { method: 'POST', credentials: 'include' },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleApiResponse(response);
  return response.json() as Promise<GoalListItem>;
};

export const resumeGoal = async (goalId: string): Promise<GoalListItem> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${goalId}/resume`,
    { method: 'POST', credentials: 'include' },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleApiResponse(response);
  return response.json() as Promise<GoalListItem>;
};

export const cancelGoal = async (goalId: string): Promise<GoalListItem> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${goalId}/cancel`,
    { method: 'POST', credentials: 'include' },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleApiResponse(response);
  return response.json() as Promise<GoalListItem>;
};
