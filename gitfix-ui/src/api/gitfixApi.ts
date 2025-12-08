// API for fetching system data from backend 

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

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
const handleApiResponse = async (response: Response): Promise<Response> => {
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

export const getTasks = async (status = 'all', limit = 50, offset = 0, repository = 'all'): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/tasks?status=${status}&limit=${limit}&offset=${offset}&repository=${repository}`, {
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

export const getRepoConfig = async (): Promise<unknown> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateRepoConfig = async (repos: string[]): Promise<unknown> => {
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

export interface PlannerDraft {
  draft_id: string;
  repository: string;
  prompt: string;
  status: 'draft' | 'review' | 'generating';
  attachments: PlannerAttachment[];
  created_at: string;
}

export interface PlannerAttachment {
  id: string;
  originalName: string;
  tokenEstimate: number;
}

export interface ContextStats {
  tokenCount: number;
  costEstimate: number;
  smartFiles: number;
}

export const createDraft = async (repository: string, prompt: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, prompt }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getDraft = async (id: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${id}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getContextStats = async (draftId: string, config: { level: string }): Promise<ContextStats> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/context/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId, ...config }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const uploadAttachment = async (draftId: string, file: File): Promise<PlannerAttachment> => {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/attachments`, {
    method: 'POST',
    body: formData,
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const removeAttachment = async (draftId: string, attachmentId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/attachments/${attachmentId}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export const generatePlan = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};
