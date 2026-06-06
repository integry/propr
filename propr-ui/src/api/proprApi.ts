// API for fetching system data from backend
import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

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

export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  return fetch(input, init);
};

// Re-export all types for backward compatibility
export * from './proprTypes';

import type {
  SystemStatus, StatusResponse, TaskAnalysisResponse, QueueStats, GeneratingPlansResponse,
  GetTasksOptions, MonitoredRepo, RepoConfigResponse, RepoBranchesResponse,
  StopExecutionResponse, DeleteTaskResponse, SystemSettings
} from './proprTypes';

export type { UserRepoPreferences } from './userRepoPreferencesApi';

export const handleApiResponse = async (response: Response): Promise<Response> => {
  if (response.status === 401) {
    if (window.location.pathname === '/login') throw new Error('Authentication required');
    window.location.href = '/login';
    throw new Error('Authentication required');
  }
  if (response.status === 403 || response.status === 405) {
    let data: { code?: string; error?: string } | null = null;
    try {
      data = await response.clone().json() as { code?: string; error?: string };
    } catch { /* Preserve the generic status fallback for malformed error bodies. */ }
    if (data?.code === DEMO_MODE_READ_ONLY_CODE) {
      throw new DemoModeReadOnlyError(data.error);
    }
    if (data?.error) throw new Error(data.error);
  }
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  return response;
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
    agents,
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

export const getTasks = async (
  statusOrOptions: string | GetTasksOptions = 'all', limit = 50, offset = 0, repository = 'all', search = ''
): Promise<unknown> => {
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

export const getRepoConfig = async (): Promise<RepoConfigResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/repos`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateRepoConfig = async (repos: MonitoredRepo[]): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/repos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repos_to_monitor: repos }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAvailableGithubRepos = async (): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/github/repos`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getRepoBranches = async (owner: string, repo: string): Promise<RepoBranchesResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getSettings = async (): Promise<SystemSettings> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/settings`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateSettings = async (settings: Record<string, unknown>): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getFollowupKeywords = async (): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/followup-keywords`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateFollowupKeywords = async (keywords: string[]): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/followup-keywords`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ followup_keywords: keywords }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getFollowupIgnoreKeywords = async (): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/followup-ignore-keywords`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateFollowupIgnoreKeywords = async (keywords: string[]): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/followup-ignore-keywords`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ followup_ignore_keywords: keywords }), credentials: 'include'
  });
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

export const getPrLabel = async (): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/pr-label`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrLabel = async (prLabel: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/pr-label`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr_label: prLabel }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAiPrimaryTag = async (): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/ai-primary-tag`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateAiPrimaryTag = async (aiPrimaryTag: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/ai-primary-tag`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_primary_tag: aiPrimaryTag }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getPrimaryProcessingLabels = async (): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/primary-processing-labels`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrimaryProcessingLabels = async (primaryLabels: string[]): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/primary-processing-labels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary_processing_labels: primaryLabels }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
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

export const getCurrentUser = async (): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/auth/user`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const logout = (): void => {
  window.location.href = `${API_BASE_URL}/api/auth/logout`;
};

export type CliVersionType = 'default' | 'tag' | 'specific' | 'custom';

export interface AgentConfig {
  id: string;
  type: 'claude' | 'codex' | 'antigravity' | 'vibe';
  alias: string;
  enabled: boolean;
  dockerImage: string;
  configPath: string;
  supportedModels: string[];
  defaultModel?: string;
  envVars?: Record<string, string>;
  modelCustomLabels?: Record<string, string>;
  // CLI Version Configuration
  cliVersionType?: CliVersionType;
  cliVersion?: string;
  cliVersionResolved?: string;
}

export const getAgents = async (): Promise<{ agents: AgentConfig[] }> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/agents`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const saveAgents = async (agents: AgentConfig[]): Promise<void> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents }), credentials: 'include'
  });
  await handleApiResponse(response);
};


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
