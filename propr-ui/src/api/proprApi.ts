import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import type { Task as ApiTask } from './tasks';
import { getApiBaseUrl } from '../config/runtimeConfig';

export const API_BASE_URL = getApiBaseUrl();
export const INSTANCE_AUTHORIZATION_CHANGED_EVENT = 'propr:instance-authorization-changed';

export interface DemoModeStatus {
  demoMode: boolean;
}

export class DemoModeReadOnlyError extends Error {
  readonly code = DEMO_MODE_READ_ONLY_CODE;

  constructor(message = 'Demo mode is read-only. Write and AI execution actions are disabled.') {
    super(message);
    this.name = 'DemoModeReadOnlyError';
  }
}

export const isDemoModeReadOnlyError = (error: unknown): error is DemoModeReadOnlyError =>
  error instanceof DemoModeReadOnlyError || (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === DEMO_MODE_READ_ONLY_CODE
  );

const shouldRetryAfterTokenRefresh = async (response: Response): Promise<boolean> => {
  if (response.status !== 401) return false;
  try {
    const data = await response.clone().json() as { code?: string };
    return data.code === 'TOKEN_REFRESHED';
  } catch {
    return false;
  }
};

const isReplayableApiRequest = (input: RequestInfo | URL, init?: RequestInit): boolean => {
  const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request && (input.body || input.bodyUsed)) return false;
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
};

export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);
  if (isReplayableApiRequest(input, init) && await shouldRetryAfterTokenRefresh(response)) return fetch(input, init);
  return response;
};

// Re-export all types for backward compatibility
export * from './proprTypes';

import type {
  SystemStatus, StatusResponse, TaskAnalysisResponse, QueueStats, GeneratingPlansResponse,
  GetTasksOptions, StopExecutionResponse, DeleteTaskResponse, CurrentUser,
  InstanceCatalogResponse
} from './proprTypes';

export type { UserRepoPreferences } from './userRepoPreferencesApi';

export const handleApiResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;
  if (response.status === 401) {
    if (window.location.pathname === '/login') throw new Error('Authentication required');
    window.location.href = '/login';
    throw new Error('Authentication required');
  }

  let data: { code?: string; error?: string; message?: string } | null = null;
  try {
    data = await response.clone().json() as { code?: string; error?: string; message?: string };
  } catch { /* Preserve the generic status fallback for malformed error bodies. */ }
  if (data?.code === DEMO_MODE_READ_ONLY_CODE) {
    throw new DemoModeReadOnlyError(data.message || data.error);
  }
  if (data?.code === 'INSUFFICIENT_INSTANCE_PERMISSION') {
    window.dispatchEvent(new Event(INSTANCE_AUTHORIZATION_CHANGED_EVENT));
  }
  if (response.status < 500 && (data?.message || data?.error)) {
    throw new Error(data.message || data.error);
  }
  throw new Error(
    response.status >= 500
      ? `The server ran into a problem (HTTP ${response.status}). Please try again in a moment.`
      : `The request could not be completed (HTTP ${response.status}).`
  );
};

export const getDemoModeStatus = async (): Promise<DemoModeStatus> => {
  const response = await apiFetch(`${API_BASE_URL}/api/auth/demo-mode`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getSystemStatus = async (): Promise<SystemStatus> => {
  const response = await apiFetch(`${API_BASE_URL}/api/status`, { credentials: 'include' });
  await handleApiResponse(response);
  const data: StatusResponse = await response.json();
  const workers: { id: number; status: string }[] = [];
  for (let i = 0; i < (data.workerCount || 0); i++) workers.push({ id: i + 1, status: 'active' });
  const mapAuthStatus = (status?: string) => status === 'connected' ? 'Authenticated' : 'Failed';
  const mapAgentStatus = (status?: string) => status === 'connected' ? 'Ready' : 'Failed';
  const mapIndexingStatus = (status?: string) => {
    switch (status) {
      case 'active':
        return 'Active';
      case 'queued':
        return 'Queued';
      case 'idle':
        return 'Idle';
      case 'failed':
        return 'Failed';
      case 'connected':
        return 'Connected';
      case 'disconnected':
        return 'Unavailable';
      default:
        return 'Unavailable';
    }
  };
  // Human-readable label for the configured intake path. An unknown or absent
  // mode (older backends) falls back to 'Unknown' so the UI never shows a raw key.
  const intakeLabels: Record<string, string> = {
    routing_websocket: 'ProPR Connect',
    polling: 'Polling',
    direct_webhook: 'Direct Webhook',
  };
  const mapIntakeLabel = (mode?: string) => (mode && intakeLabels[mode]) || 'Unknown';
  const mapIntakeStatus = (status?: string) => {
    switch (status) {
      case 'connected':
        return 'Connected';
      case 'active':
        return 'Active';
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  };
  const agents = (data.agents || []).map(agent => ({
    ...agent,
    status: mapAgentStatus(agent.status),
  }));
  return {
    daemon: data.daemon === 'running' ? 'Running' : 'Stopped',
    workers,
    redis: data.redis === 'connected' ? 'Connected' : 'Disconnected',
    githubAuth: mapAuthStatus(data.githubAuth),
    claudeAuth: mapAuthStatus(data.claudeAuth),
    indexing: mapIndexingStatus(data.indexing),
    githubEventIntake: mapIntakeLabel(data.githubEventIntake),
    githubEventIntakeStatus: mapIntakeStatus(data.githubEventIntakeStatus),
    agents,
    warnings: data.warnings || [],
  };
};

export const getQueueStats = async (): Promise<QueueStats> => {
  const [queueResponse, generatingPlansResponse] = await Promise.all([
    apiFetch(`${API_BASE_URL}/api/queue/stats`, { credentials: 'include' }),
    apiFetch(`${API_BASE_URL}/api/stats/generating-plans`, { credentials: 'include' }).catch(() => null)
  ]);
  await handleApiResponse(queueResponse);
  const queueStats: QueueStats = await queueResponse.json();
  let generatingCount = 0;
  if (generatingPlansResponse && generatingPlansResponse.ok) {
    try {
      const generatingPlans: GeneratingPlansResponse = await generatingPlansResponse.json();
      generatingCount = generatingPlans.count || 0;
    } catch { /* ignore */ }
  }
  return { ...queueStats, active: queueStats.active + generatingCount };
};

export interface GetTasksResponse { tasks: ApiTask[]; total?: number; offset?: number; limit?: number; }

export const getTasks = async (
  statusOrOptions: string | GetTasksOptions = 'all', limit = 50, offset = 0, repository = 'all', search = ''
): Promise<GetTasksResponse> => {
  let options: GetTasksOptions;
  if (typeof statusOrOptions === 'object') options = statusOrOptions;
  else options = { status: statusOrOptions, limit, offset, repository, search };
  const params = new URLSearchParams({
    status: options.status || 'all', limit: (options.limit ?? 50).toString(),
    offset: (options.offset ?? 0).toString(), repository: options.repository || 'all'
  });
  if (options.search) params.append('search', options.search);
  if (options.forReview) params.append('forReview', 'true');
  if (options.excludeMerged) params.append('excludeMerged', 'true');
  const response = await apiFetch(`${API_BASE_URL}/api/tasks?${params.toString()}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskHistory = async (taskId: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/history`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskAnalysis = async (taskId: string): Promise<TaskAnalysisResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/analysis`, { credentials: 'include' });
  if (response.status === 202) return { analysis: null, message: 'Analysis pending...' };
  await handleApiResponse(response);
  return response.json();
};

export const getTaskLiveDetails = async (taskId: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/live-details`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getInstanceCatalog = async (): Promise<InstanceCatalogResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/catalog`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const fetchPrompt = async (promptPath: string): Promise<string> => {
  const response = await apiFetch(`${API_BASE_URL}${promptPath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.text();
};

export const fetchLogFiles = async (logsPath: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}${logsPath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const fetchLogFile = async (logFilePath: string): Promise<string> => {
  const response = await apiFetch(`${API_BASE_URL}${logFilePath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.text();
};

export const stopTaskExecution = async (taskId: string): Promise<StopExecutionResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/stop`, { method: 'POST', credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const deleteTask = async (taskId: string, force?: boolean): Promise<void> => {
  const url = force ? `${API_BASE_URL}/api/tasks/${taskId}?force=true` : `${API_BASE_URL}/api/tasks/${taskId}`;
  const response = await apiFetch(url, { method: 'DELETE', credentials: 'include' });
  if (response.status === 204) return;
  if (response.status === 400) {
    const data: DeleteTaskResponse = await response.json();
    throw new Error(data.message || data.error || 'Cannot delete task in active state');
  }
  await handleApiResponse(response);
};

export const getCurrentUser = async (): Promise<CurrentUser> => {
  const response = await apiFetch(`${API_BASE_URL}/api/auth/user`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const logout = (): void => {
  window.location.href = `${API_BASE_URL}/api/auth/logout`;
};

export * from './configApi';
export * from './plannerApi';
export * from './taskStatsApi';
export * from './agentChatApi';
export * from './repoIndexingApi';
export * from './summaryApi';
export * from './planIssuesApi';
export * from './repoChatApi';
export * from './repoImprovementsApi';
export * from './tasks';
export * from './repoTodosApi';
export * from './userRepoPreferencesApi';
export * from './revertApi';
export * from './agentLoginApi';

export type { ChatMessage } from './plannerApi';
export type { PlanIssueStatus } from './planIssuesApi';
export type {
  CommitInfo, DeleteTaskResponse, PostFollowupResponse,
  RevertParams, RevertPreviewResponse, TriggerReindexAllResponse
} from './proprTypes';
