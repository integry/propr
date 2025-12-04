// API for fetching system data from backend

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

// Helper function to handle API responses and auth
const handleApiResponse = async (response) => {
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

export const getSystemStatus = async () => {
  const response = await fetch(`${API_BASE_URL}/api/status`, {
    credentials: 'include' // Include cookies for session
  });
  await handleApiResponse(response);
  const data = await response.json();
  
  // Transform backend response to match frontend expectations
  let workers = [];
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

export const getQueueStats = async () => {
  const response = await fetch(`${API_BASE_URL}/api/queue/stats`, {
    credentials: 'include' // Include cookies for session
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTasks = async (status = 'all', limit = 50, offset = 0, repository = 'all') => {
  const response = await fetch(`${API_BASE_URL}/api/tasks?status=${status}&limit=${limit}&offset=${offset}&repository=${repository}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskHistory = async (taskId) => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/history`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskAnalysis = async (taskId) => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/analysis`, {
    credentials: 'include'
  });
  if (response.status === 202) return { analysis: null, message: 'Analysis pending...' };
  await handleApiResponse(response);
  return response.json();
};

export const getTaskLiveDetails = async (taskId) => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/live-details`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getRepoConfig = async () => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateRepoConfig = async (repos) => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repos_to_monitor: repos }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAvailableGithubRepos = async () => {
  const response = await fetch(`${API_BASE_URL}/api/github/repos`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getSettings = async () => {
  const response = await fetch(`${API_BASE_URL}/api/config/settings`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateSettings = async (settings) => {
  const response = await fetch(`${API_BASE_URL}/api/config/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getFollowupKeywords = async () => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-keywords`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateFollowupKeywords = async (keywords) => {
  const response = await fetch(`${API_BASE_URL}/api/config/followup-keywords`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ followup_keywords: keywords }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const fetchPrompt = async (promptPath) => {
  const response = await fetch(`${API_BASE_URL}${promptPath}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.text();
};

export const fetchLogFiles = async (logsPath) => {
  const response = await fetch(`${API_BASE_URL}${logsPath}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const fetchLogFile = async (logFilePath) => {
  const response = await fetch(`${API_BASE_URL}${logFilePath}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.text();
};

export const getPrLabel = async () => {
  const response = await fetch(`${API_BASE_URL}/api/config/pr-label`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrLabel = async (prLabel) => {
  const response = await fetch(`${API_BASE_URL}/api/config/pr-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr_label: prLabel }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAiPrimaryTag = async () => {
  const response = await fetch(`${API_BASE_URL}/api/config/ai-primary-tag`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateAiPrimaryTag = async (aiPrimaryTag) => {
  const response = await fetch(`${API_BASE_URL}/api/config/ai-primary-tag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_primary_tag: aiPrimaryTag }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getPrimaryProcessingLabels = async () => {
  const response = await fetch(`${API_BASE_URL}/api/config/primary-processing-labels`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updatePrimaryProcessingLabels = async (primaryLabels) => {
  const response = await fetch(`${API_BASE_URL}/api/config/primary-processing-labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary_processing_labels: primaryLabels }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const stopTaskExecution = async (taskId) => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/stop`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const generateDeepDiveAnalysis = async (taskId) => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/deep-dive-analysis`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getCurrentUser = async () => {
  const response = await fetch(`${API_BASE_URL}/api/auth/user`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const logout = () => {
  window.location.href = `${API_BASE_URL}/api/auth/logout`;
};