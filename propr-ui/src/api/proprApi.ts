// API for fetching system data from backend
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

interface SystemStatus {
  daemon: string;
  workers: { id: number; status: string }[];
  redis: string;
  githubAuth: string;
  claudeAuth: string;
}

interface StatusResponse {
  daemon: string;
  workerCount?: number;
  redis: string;
  githubAuth: string;
  claudeAuth: string;
}

interface TaskAnalysisResponse {
  analysis: unknown | null;
  message?: string;
}

// Helper function to handle API responses and auth
export const handleApiResponse = async (response: Response): Promise<Response> => {
  if (response.status === 401) {
    if (window.location.pathname === '/login') {
      throw new Error('Authentication required');
    }
    window.location.href = '/login';
    throw new Error('Authentication required');
  }
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }
  return response;
};

export const getSystemStatus = async (): Promise<SystemStatus> => {
  const response = await fetch(`${API_BASE_URL}/api/status`, { credentials: 'include' });
  await handleApiResponse(response);
  const data: StatusResponse = await response.json();
  const workers: { id: number; status: string }[] = [];
  for (let i = 0; i < (data.workerCount || 0); i++) {
    workers.push({ id: i + 1, status: 'active' });
  }
  return {
    daemon: data.daemon === 'running' ? 'Running' : 'Stopped',
    workers: workers,
    redis: data.redis === 'connected' ? 'Connected' : 'Disconnected',
    githubAuth: data.githubAuth === 'connected' ? 'Authenticated' : 'Failed',
    claudeAuth: data.claudeAuth === 'connected' ? 'Authenticated' : 'Failed',
  };
};

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

interface GeneratingPlansResponse {
  count: number;
}

export const getQueueStats = async (): Promise<QueueStats> => {
  const [queueResponse, generatingPlansResponse] = await Promise.all([
    fetch(`${API_BASE_URL}/api/queue/stats`, { credentials: 'include' }),
    fetch(`${API_BASE_URL}/api/stats/generating-plans`, { credentials: 'include' }).catch(() => null)
  ]);

  await handleApiResponse(queueResponse);
  const queueStats: QueueStats = await queueResponse.json();

  // Add generating plans count to active tasks if fetch succeeded
  let generatingCount = 0;
  if (generatingPlansResponse && generatingPlansResponse.ok) {
    try {
      const generatingPlans: GeneratingPlansResponse = await generatingPlansResponse.json();
      generatingCount = generatingPlans.count || 0;
    } catch {
      // Ignore JSON parsing errors
    }
  }

  return {
    ...queueStats,
    active: queueStats.active + generatingCount
  };
};

export interface GetTasksOptions {
  status?: string;
  limit?: number;
  offset?: number;
  repository?: string;
  search?: string;
  /** Filter to only include tasks that need review (completed or failed) */
  forReview?: boolean;
  /** Exclude tasks where plan_issue_status is 'merged' */
  excludeMerged?: boolean;
}

export const getTasks = async (
  statusOrOptions: string | GetTasksOptions = 'all',
  limit = 50,
  offset = 0,
  repository = 'all',
  search = ''
): Promise<unknown> => {
  // Support both old signature (positional args) and new options object
  let options: GetTasksOptions;
  if (typeof statusOrOptions === 'object') {
    options = statusOrOptions;
  } else {
    options = { status: statusOrOptions, limit, offset, repository, search };
  }

  const params = new URLSearchParams({
    status: options.status || 'all',
    limit: (options.limit ?? 50).toString(),
    offset: (options.offset ?? 0).toString(),
    repository: options.repository || 'all'
  });
  if (options.search) params.append('search', options.search);
  if (options.forReview) params.append('forReview', 'true');
  if (options.excludeMerged) params.append('excludeMerged', 'true');

  const response = await fetch(`${API_BASE_URL}/api/tasks?${params.toString()}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskHistory = async (taskId: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/history`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskAnalysis = async (taskId: string): Promise<TaskAnalysisResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/analysis`, { credentials: 'include' });
  if (response.status === 202) return { analysis: null, message: 'Analysis pending...' };
  await handleApiResponse(response);
  return response.json();
};

export const getTaskLiveDetails = async (taskId: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/live-details`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export interface MonitoredRepo {
  id: string;
  name: string;
  enabled: boolean;
  alias?: string;
  baseBranch?: string;
  starred?: boolean;
  hidden?: boolean;
}

export interface RepoConfigResponse {
  repos_to_monitor: MonitoredRepo[];
}

export const getRepoConfig = async (): Promise<RepoConfigResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateRepoConfig = async (repos: MonitoredRepo[]): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repos_to_monitor: repos }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAvailableGithubRepos = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/github/repos`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export interface RepoBranchesResponse {
  branches: string[];
  defaultBranch: string;
}

export const getRepoBranches = async (owner: string, repo: string): Promise<RepoBranchesResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getSettings = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/settings`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateSettings = async (settings: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getFollowupKeywords = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-keywords`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateFollowupKeywords = async (keywords: string[]): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-keywords`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ followup_keywords: keywords }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getFollowupIgnoreKeywords = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-ignore-keywords`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateFollowupIgnoreKeywords = async (keywords: string[]): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-ignore-keywords`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ followup_ignore_keywords: keywords }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const fetchPrompt = async (promptPath: string): Promise<string> => {
  const response = await fetch(`${API_BASE_URL}${promptPath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.text();
};

export const fetchLogFiles = async (logsPath: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}${logsPath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const fetchLogFile = async (logFilePath: string): Promise<string> => {
  const response = await fetch(`${API_BASE_URL}${logFilePath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.text();
};

export const getPrLabel = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/pr-label`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrLabel = async (prLabel: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/pr-label`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr_label: prLabel }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAiPrimaryTag = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/ai-primary-tag`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateAiPrimaryTag = async (aiPrimaryTag: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/ai-primary-tag`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_primary_tag: aiPrimaryTag }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getPrimaryProcessingLabels = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/primary-processing-labels`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrimaryProcessingLabels = async (primaryLabels: string[]): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/primary-processing-labels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary_processing_labels: primaryLabels }), credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface StopExecutionResponse {
  success: boolean;
  containerStopped: boolean;
  containerId?: string;
  message?: string;
}

export const stopTaskExecution = async (taskId: string): Promise<StopExecutionResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/stop`, { method: 'POST', credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export interface DeleteTaskResponse {
  error?: string;
  message?: string;
  currentState?: string;
}

export const deleteTask = async (taskId: string, force?: boolean): Promise<void> => {
  const url = force
    ? `${API_BASE_URL}/api/tasks/${taskId}?force=true`
    : `${API_BASE_URL}/api/tasks/${taskId}`;
  const response = await fetch(url, { method: 'DELETE', credentials: 'include' });
  if (response.status === 204) {
    return; // Success, no content
  }
  if (response.status === 400) {
    const data: DeleteTaskResponse = await response.json();
    throw new Error(data.message || data.error || 'Cannot delete task in active state');
  }
  await handleApiResponse(response);
};

export const getCurrentUser = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/auth/user`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const logout = (): void => {
  window.location.href = `${API_BASE_URL}/api/auth/logout`;
};

export interface AgentConfig {
  id: string;
  type: 'claude' | 'codex' | 'gemini';
  alias: string;
  enabled: boolean;
  dockerImage: string;
  configPath: string;
  supportedModels: string[];
  defaultModel?: string;
  envVars?: Record<string, string>;
  modelCustomLabels?: Record<string, string>;
}

export const getAgents = async (): Promise<{ agents: AgentConfig[] }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agents`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const saveAgents = async (agents: AgentConfig[]): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents }), credentials: 'include'
  });
  await handleApiResponse(response);
};

export interface RevertParams {
  repo: string;
  pr: string;
  commit: string;
  commentId: string;
  owner: string;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string | null;
}

export interface RevertPreviewResponse {
  branch: string;
  baseBranch: string;
  targetCommit: { sha: string; shortSha: string };
  newHead: CommitInfo | null;
  commitsToRemove: CommitInfo[];
  remainingCommits: CommitInfo[];
  willRevertToBase: boolean;
}

export const getRevertPreview = async (params: { owner: string; repo: string; pr: string; commit: string }): Promise<RevertPreviewResponse> => {
  const queryParams = new URLSearchParams(params);
  const response = await fetch(`${API_BASE_URL}/api/tasks/revert-preview?${queryParams}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const revertCommit = async (params: RevertParams): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/tasks/revert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params), credentials: 'include'
  });
  await handleApiResponse(response);
};

export interface SummarizationSettings {
  enabled: boolean;
  agent_alias: string;
  custom_prompt?: string;
  default_prompt?: string;
}

export const getSummarizationSettings = async (): Promise<SummarizationSettings> => {
  const response = await fetch(`${API_BASE_URL}/api/config/summarization`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateSummarizationSettings = async (settings: SummarizationSettings): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/config/summarization`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings), credentials: 'include'
  });
  await handleApiResponse(response);
};

export interface TriggerReindexAllResponse { success: boolean; repositoriesQueued: number; }
export const triggerReindexAll = async (): Promise<TriggerReindexAllResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/config/summarization/reindex-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export interface PostFollowupResponse { success: boolean; message: string; }
export const postTaskFollowup = async (taskId: string, body: string): Promise<PostFollowupResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/followup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }), credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export * from './plannerApi';
export * from './taskStatsApi';
export * from './agentChatApi';
export * from './repoIndexingApi';
export * from './summaryApi';
export * from './planIssuesApi';
export * from './repoChatApi';
export * from './repoImprovementsApi';
export * from './repoTodosApi';
