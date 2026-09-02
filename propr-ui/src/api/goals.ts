import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export interface GoalCapability {
  agentId: string;
  agentAlias: string;
  agentType: string;
  goalCapable: boolean;
  reason?: string;
  models: string[];
  defaultModel: string | null;
}

export type GoalLaunchStrategy = 'direct' | 'orchestrate';

export interface Goal {
  id: string;
  owner: string;
  repository: string;
  objective: string;
  launchStrategy: GoalLaunchStrategy;
  initialPrompt: string;
  baseBranch: string | null;
  branchName: string | null;
  worktreePath: string | null;
  agent: { id: string; alias: string; type: string };
  requestedModel: string;
  effectiveModel: string | null;
  maxParallelTasks: number | null;
  ultrafix: boolean | null;
  desiredState: 'running' | 'paused' | 'cancelled';
  resultState: 'completed' | 'failed' | 'cancelled' | null;
  taskId: string;
  sessionId: string | null;
  conversationId: string | null;
  finalPr: { number: number | null; url: string } | null;
  artifacts: unknown[];
  taskState: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  elapsedMs: number;
  pausedMs: number;
  activeMs: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  await handleApiResponse(response);
  return response.json();
}

export const getGoalCapabilities = async () =>
  request<{ agents: GoalCapability[] }>('/api/goals/capabilities');
export const listGoals = async () => request<{ goals: Goal[] }>('/api/goals');
export const getGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}`);
export const createGoal = async (body: { repository: string; objective: string; launchStrategy: GoalLaunchStrategy; agentId: string; model: string; baseBranch?: string; maxParallelTasks?: number; ultrafix?: boolean }) =>
  request<{ goal: Goal }>('/api/goals', { method: 'POST', body: JSON.stringify(body) });
export const pauseGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/pause`, { method: 'POST' });
export const resumeGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/resume`, { method: 'POST' });
export const cancelGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
export const requestGoalModel = async (id: string, model: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/model`, { method: 'PATCH', body: JSON.stringify({ model }) });
export const sendGoalInput = async (id: string, body: { message?: string; canned?: 'done' | 'left' }) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/input`, { method: 'POST', body: JSON.stringify(body) });
