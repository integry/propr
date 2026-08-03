import type {
  AgentConfig,
  MonitoredRepo,
  RepoBranchesResponse,
  RepoConfigResponse,
  SystemSettings,
} from './proprTypes';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  await handleApiResponse(response);
  return response.json();
}

export const getRepoConfig = (): Promise<RepoConfigResponse> => getJson('/api/config/repos');
export const updateRepoConfig = (repos: MonitoredRepo[]): Promise<unknown> =>
  postJson('/api/config/repos', { repos_to_monitor: repos });
export const getAvailableGithubRepos = (): Promise<unknown> => getJson('/api/github/repos');
export const getRepoBranches = (owner: string, repo: string): Promise<RepoBranchesResponse> =>
  getJson(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
export const getSettings = (): Promise<SystemSettings> => getJson('/api/config/settings');

export interface ConfigUpdateResponse {
  success: boolean;
  settings?: Record<string, unknown>;
  warnings?: string[];
}

export const updateSettings = (settings: Record<string, unknown>): Promise<ConfigUpdateResponse> =>
  postJson('/api/config/settings', { settings });
export const getFollowupKeywords = (): Promise<unknown> => getJson('/api/config/followup-keywords');
export const updateFollowupKeywords = (keywords: string[]): Promise<unknown> =>
  postJson('/api/config/followup-keywords', { followup_keywords: keywords });
export const getFollowupIgnoreKeywords = (): Promise<unknown> => getJson('/api/config/followup-ignore-keywords');
export const updateFollowupIgnoreKeywords = (keywords: string[]): Promise<unknown> =>
  postJson('/api/config/followup-ignore-keywords', { followup_ignore_keywords: keywords });
export const getPrLabel = (): Promise<unknown> => getJson('/api/config/pr-label');
export const updatePrLabel = (prLabel: string): Promise<unknown> =>
  postJson('/api/config/pr-label', { pr_label: prLabel });
export const getAiPrimaryTag = (): Promise<unknown> => getJson('/api/config/ai-primary-tag');
export const updateAiPrimaryTag = (aiPrimaryTag: string): Promise<unknown> =>
  postJson('/api/config/ai-primary-tag', { ai_primary_tag: aiPrimaryTag });
export const getPrimaryProcessingLabels = (): Promise<unknown> => getJson('/api/config/primary-processing-labels');
export const updatePrimaryProcessingLabels = (primaryLabels: string[]): Promise<unknown> =>
  postJson('/api/config/primary-processing-labels', { primary_processing_labels: primaryLabels });

export interface SaveAgentsResponse {
  success: boolean;
  agents: AgentConfig[];
  warnings?: string[];
}

export const getAgents = (): Promise<{ agents: AgentConfig[] }> => getJson('/api/config/agents');
export const saveAgents = (agents: AgentConfig[]): Promise<SaveAgentsResponse> =>
  postJson('/api/config/agents', { agents });
export const getOpenCodeModels = (agentId?: string): Promise<{ models: string[] }> => {
  const params = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  return getJson(`/api/agents/opencode/models${params}`);
};
