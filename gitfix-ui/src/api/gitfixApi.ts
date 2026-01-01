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
  const response = await fetch(`${API_BASE_URL}/api/status`, {
    credentials: 'include' // Include cookies for session
  });
  await handleApiResponse(response);
  const data: StatusResponse = await response.json();
  
  // Transform backend response to match frontend expectations
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

export const getQueueStats = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/queue/stats`, {
    credentials: 'include' // Include cookies for session
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTasks = async (status = 'all', limit = 50, offset = 0, repository = 'all', search = ''): Promise<unknown> => {
  // Use URLSearchParams for cleaner query construction
  const params = new URLSearchParams({
    status,
    limit: limit.toString(),
    offset: offset.toString(),
    repository,
  });

  if (search) params.append('search', search);

  const response = await fetch(`${API_BASE_URL}/api/tasks?${params.toString()}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskHistory = async (taskId: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/history`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskAnalysis = async (taskId: string): Promise<TaskAnalysisResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/analysis`, {
    credentials: 'include'
  });
  if (response.status === 202) return { analysis: null, message: 'Analysis pending...' };
  await handleApiResponse(response);
  return response.json();
};

export const getTaskLiveDetails = async (taskId: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/live-details`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface MonitoredRepo {
  name: string;
  enabled: boolean;
}

export interface RepoConfigResponse {
  repos_to_monitor: MonitoredRepo[];
}

export const getRepoConfig = async (): Promise<RepoConfigResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateRepoConfig = async (repos: MonitoredRepo[]): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repos_to_monitor: repos }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAvailableGithubRepos = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/github/repos`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getSettings = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/settings`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateSettings = async (settings: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getFollowupKeywords = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-keywords`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateFollowupKeywords = async (keywords: string[]): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-keywords`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ followup_keywords: keywords }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const fetchPrompt = async (promptPath: string): Promise<string> => {
  const response = await fetch(`${API_BASE_URL}${promptPath}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.text();
};

export const fetchLogFiles = async (logsPath: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}${logsPath}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const fetchLogFile = async (logFilePath: string): Promise<string> => {
  const response = await fetch(`${API_BASE_URL}${logFilePath}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.text();
};

export const getPrLabel = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/pr-label`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrLabel = async (prLabel: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/pr-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr_label: prLabel }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAiPrimaryTag = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/ai-primary-tag`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateAiPrimaryTag = async (aiPrimaryTag: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/ai-primary-tag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_primary_tag: aiPrimaryTag }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getPrimaryProcessingLabels = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/primary-processing-labels`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrimaryProcessingLabels = async (primaryLabels: string[]): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/primary-processing-labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary_processing_labels: primaryLabels }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const stopTaskExecution = async (taskId: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/stop`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const generateDeepDiveAnalysis = async (taskId: string): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/deep-dive-analysis`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getCurrentUser = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/auth/user`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const logout = (): void => {
  window.location.href = `${API_BASE_URL}/api/auth/logout`;
};

// Agent Configuration Types and API
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
}

export const getAgents = async (): Promise<{ agents: AgentConfig[] }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agents`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const saveAgents = async (agents: AgentConfig[]): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

// Revert API
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
  targetCommit: {
    sha: string;
    shortSha: string;
  };
  newHead: CommitInfo | null;
  commitsToRemove: CommitInfo[];
  remainingCommits: CommitInfo[];
  willRevertToBase: boolean;
}

export const getRevertPreview = async (params: {
  owner: string;
  repo: string;
  pr: string;
  commit: string;
}): Promise<RevertPreviewResponse> => {
  const queryParams = new URLSearchParams(params);
  const response = await fetch(`${API_BASE_URL}/api/tasks/revert-preview?${queryParams}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const revertCommit = async (params: RevertParams): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/tasks/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

// Summarization Settings
export interface SummarizationSettings {
  enabled: boolean;
  agent_alias: string;
}

export const getSummarizationSettings = async (): Promise<SummarizationSettings> => {
  const response = await fetch(`${API_BASE_URL}/api/config/summarization`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateSummarizationSettings = async (settings: SummarizationSettings): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/config/summarization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
    credentials: 'include'
  });
  await handleApiResponse(response);
};
export * from './plannerApi';
export * from './taskStatsApi';
export * from './agentChatApi';
export * from './repoIndexingApi';
export * from './summaryApi';
