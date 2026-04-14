import { API_BASE_URL, handleApiResponse } from './proprApi';

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

// Agent Tank settings API
export interface AgentTankSettingsResponse { enabled: boolean; url: string; }
export interface AgentTankStatusResponse { available: boolean; reason?: string; }

export const getAgentTankSettings = async (): Promise<AgentTankSettingsResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agent-tank`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateAgentTankSettings = async (settings: { enabled: boolean; url: string }): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agent-tank`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings), credentials: 'include'
  });
  await handleApiResponse(response);
};

export const getAgentTankStatus = async (): Promise<AgentTankStatusResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agent-tank/status`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

// Agent Tank usage data types
export interface AgentUsageMetric {
  label?: string;
  percent: number;
  resetsIn?: string;
  resetsAt?: string;
}

export interface AgentUsageData {
  name: string;
  usage: {
    session?: AgentUsageMetric;
    weeklyAll?: AgentUsageMetric;
    weeklySonnet?: AgentUsageMetric;
    weekly?: AgentUsageMetric;
    models?: Array<{ model: string; percentUsed: number; resetsIn?: string }>;
    fiveHour?: { percentUsed: number; resetsIn?: string };
  } | null;
  error?: string | null;
  isRefreshing?: boolean;
}

export interface AgentTankUsageResponse {
  enabled: boolean;
  agents?: Record<string, AgentUsageData>;
  error?: string;
}

export const getAgentTankUsage = async (): Promise<AgentTankUsageResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agent-tank/usage`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const refreshAgentTank = async (): Promise<{ success: boolean; error?: string }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agent-tank/refresh`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface AgentTankDetectResponse {
  detected: boolean;
  url?: string;
  reason?: string;
}

export const detectAgentTank = async (): Promise<AgentTankDetectResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agent-tank/detect`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const enableAgentTank = async (url: string): Promise<{ success: boolean }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/agent-tank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, url }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface PostFollowupResponse { success: boolean; message: string; }
export const postTaskFollowup = async (taskId: string, body: string): Promise<PostFollowupResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/followup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }), credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};
