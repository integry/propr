import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export interface GoalCapability {
  agentId: string;
  agentAlias: string;
  agentType: string;
  goalCapable: boolean;
  lifecycle: {
    launch: 'native-goal' | 'goal-prompt';
    resume: 'native-goal' | 'whole-session';
    runningInput: 'live-steer' | 'safe-boundary-resume';
  } | null;
  controls: {
    liveInput: boolean;
    inputAtBoundary: boolean;
    modelAtBoundary: boolean;
    pauseAtBoundary: boolean;
  };
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
  failureReason: string | null;
  pausePending: boolean;
  control: { requestGeneration: number; acknowledgedGeneration: number; pending: boolean };
  taskId: string;
  sessionId: string | null;
  conversationId: string | null;
  finalPr: { number: number | null; url: string } | null;
  checkpoint: {
    intervalMinutes: number | null;
    count: number;
    lastAt: string | null;
    lastCommitSha: string | null;
    error: string | null;
    pending: boolean;
    latest: {
      kind: 'bootstrap' | 'manual' | 'automatic' | 'final';
      state: 'pending' | 'processing' | 'completed' | 'skipped' | 'failed';
      commitSha: string | null;
      error: string | null;
      createdAt: string;
      completedAt: string | null;
    } | null;
  } | null;
  artifacts: unknown[];
  artifactStats: { issues: number; openIssues: number; pullRequests: number; openPullRequests: number };
  liveSummary: {
    currentTask: string | null;
    todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
    tokenUsage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null;
    nativeGoal: { objective: string; status: string; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number } | null;
  };
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
  const requestInit = {
    credentials: 'include' as const,
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  };
  const retryable = new Headers(requestInit.headers).has('Idempotency-Key');
  let lastError: unknown;
  for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt += 1) {
    try {
      const response = await apiFetch(`${API_BASE_URL}${path}`, requestInit);
      await handleApiResponse(response);
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const idempotentMutation = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { 'Idempotency-Key': crypto.randomUUID() },
});

export const getGoalCapabilities = async (recheck = false) =>
  request<{ agents: GoalCapability[] }>(`/api/goals/capabilities${recheck ? '?recheck=true' : ''}`);
export const listGoals = async () => request<{ goals: Goal[] }>('/api/goals');
export const getGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}`);
export const deleteGoal = async (id: string): Promise<void> => {
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(id)}`, {
    method: 'DELETE', credentials: 'include',
  });
  await handleApiResponse(response);
};
export const createGoal = async (body: { repository: string; objective: string; launchStrategy: GoalLaunchStrategy; agentId: string; model: string; baseBranch?: string; maxParallelTasks?: number; ultrafix?: boolean; checkpointIntervalMinutes?: number }) =>
  request<{ goal: Goal }>('/api/goals', idempotentMutation('POST', body));
export const pauseGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/pause`, idempotentMutation('POST'));
export const resumeGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/resume`, idempotentMutation('POST'));
export const cancelGoal = async (id: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/cancel`, idempotentMutation('POST'));
export const requestGoalModel = async (id: string, model: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/model`, idempotentMutation('PATCH', { model }));
export const sendGoalInput = async (id: string, body: { message?: string; canned?: 'done' | 'left' }) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/input`, idempotentMutation('POST', body));
export const checkpointGoal = async (id: string, commitMessage?: string) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/checkpoint`, idempotentMutation('POST', commitMessage ? { commitMessage } : {}));
export const requestGoalCheckpointInterval = async (id: string, minutes: number) => request<{ goal: Goal }>(`/api/goals/${encodeURIComponent(id)}/checkpoint-frequency`, idempotentMutation('PATCH', { minutes }));
