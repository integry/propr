import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
import {
  AGENT_TANK_LEGACY_BACKEND_MESSAGE,
  buildAgentTankSettingsRequest,
  supportsAgentTankModes,
  type AgentTankHistoryResponse,
  type AgentTankMode,
} from '@propr/shared';
import type { FollowupRunsResponse, PostFollowupResponse, SummarizationSettings } from './proprTypes';

export type { SummarizationSettings };
export type { AgentTankHistoryAgent, AgentTankHistoryPoint, AgentTankHistoryResponse, AgentTankHistorySeries } from '@propr/shared';

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
  const response = await apiFetch(`${API_BASE_URL}/api/tasks/revert-preview?${queryParams}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const revertCommit = async (params: RevertParams): Promise<void> => {
  const response = await apiFetch(`${API_BASE_URL}/api/tasks/revert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params), credentials: 'include'
  });
  await handleApiResponse(response);
};

export const getSummarizationSettings = async (): Promise<SummarizationSettings> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/summarization`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateSummarizationSettings = async (settings: SummarizationSettings): Promise<void> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/summarization`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings), credentials: 'include'
  });
  await handleApiResponse(response);
};

export interface TriggerReindexAllResponse {
  success: boolean;
  repositoriesQueued: number;
  repositoriesSkippedCooldown?: number;
  repositoriesSkippedAlreadyQueued?: number;
  repositoriesFailedClone?: number;
  ignoreCooldown?: boolean;
}
export const triggerReindexAll = async (ignoreCooldown = false): Promise<TriggerReindexAllResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/summarization/reindex-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ignoreCooldown }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

// Agent Tank settings API
export interface AgentTankSettingsResponse { mode?: AgentTankMode; enabled: boolean; url: string; }
export interface AgentTankStatusResponse { available: boolean; mode?: AgentTankMode; reason?: string; }

export const getAgentTankSettings = async (): Promise<AgentTankSettingsResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Refuse a write this backend cannot express instead of letting it answer
 * `{ success: true }` for something else.
 *
 * Only `bundled` needs the check: `external` and `disabled` both survive a
 * pre-mode backend because the request body carries the derived `enabled`
 * flag those backends read.
 */
const assertModeSupported = async (mode: AgentTankMode): Promise<void> => {
  if (mode !== 'bundled') return;
  if (supportsAgentTankModes(await getAgentTankSettings())) return;
  throw new Error(AGENT_TANK_LEGACY_BACKEND_MESSAGE);
};

export const updateAgentTankSettings = async (settings: { mode: AgentTankMode; url: string }): Promise<void> => {
  await assertModeSupported(settings.mode);
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildAgentTankSettingsRequest(settings.mode, settings.url)), credentials: 'include'
  });
  await handleApiResponse(response);
};

export const getAgentTankStatus = async (): Promise<AgentTankStatusResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank/status`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

// Agent Tank usage data types
export interface AgentUsageMetric {
  label?: string;
  percent: number;
  resetsIn?: string;
  resetsAt?: string;
  resetsInSeconds?: number;
  pace?: number;
  paceEval?: string;
}

export interface AgentUsageData {
  name: string;
  usage: {
    session?: AgentUsageMetric;
    weeklyAll?: AgentUsageMetric;
    weeklySonnet?: AgentUsageMetric;
    weeklyFable?: AgentUsageMetric;
    weekly?: AgentUsageMetric;
    // `group`/`cycle` arrive from Agent Tank 0.9.9+ for grouped Antigravity
    // pools, including the separately tracked Gemini 4 Argon quota.
    models?: Array<{ model: string; percentUsed: number; resetsIn?: string; group?: string; cycle?: string }>;
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

export const getAgentTankUsage = async (
  options: { signal?: AbortSignal } = {}
): Promise<AgentTankUsageResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank/usage`, {
    credentials: 'include',
    signal: options.signal,
  });
  await handleApiResponse(response);
  return response.json();
};

export interface AgentTankHistoryQuery {
  /** Inclusive range, epoch ms. */
  since: number;
  until?: number;
  /** ProPR-facing agent names; all agents when omitted. */
  agents?: string[];
  /** Only this Agent Tank metric key (e.g. `session`, `model:Gemini 4 Argon Weekly Limit`). */
  metric?: string;
  signal?: AbortSignal;
}

export const getAgentTankHistory = async (query: AgentTankHistoryQuery): Promise<AgentTankHistoryResponse> => {
  const params = new URLSearchParams({ since: String(Math.floor(query.since)) });
  if (query.until !== undefined) params.set('until', String(Math.floor(query.until)));
  if (query.agents?.length) params.set('agent', query.agents.join(','));
  if (query.metric) params.set('metric', query.metric);
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank/history?${params}`, {
    credentials: 'include',
    signal: query.signal,
  });
  await handleApiResponse(response);
  return response.json();
};

export const refreshAgentTank = async (): Promise<{ success: boolean; error?: string }> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank/refresh`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface AgentTankDetectResponse {
  detected: boolean;
  /** Which mode the banner should offer: bundled needs no url. */
  mode?: AgentTankMode;
  url?: string;
  reason?: string;
}

export const detectAgentTank = async (): Promise<AgentTankDetectResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank/detect`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const enableAgentTank = async (mode: AgentTankMode, url?: string): Promise<{ success: boolean }> => {
  await assertModeSupported(mode);
  const response = await apiFetch(`${API_BASE_URL}/api/config/agent-tank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildAgentTankSettingsRequest(mode, url)),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export type { PostFollowupResponse };
export const postTaskFollowup = async (taskId: string, body: string, target?: 'pull_request'): Promise<PostFollowupResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/followup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target ? { body, target } : { body }), credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export type { FollowupRunsResponse };
/** Read-only: the runs the follow-up posted as `commentId` started, which never reposts or queues it. */
export const getTaskFollowupRuns = async (taskId: string, commentId: number, options: { signal?: AbortSignal } = {}): Promise<FollowupRunsResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/followup-runs?commentId=${encodeURIComponent(String(commentId))}`, { credentials: 'include', signal: options.signal });
  await handleApiResponse(response);
  return response.json();
};

/** A separate endpoint prevents old servers from interpreting /review as implementation work. */
export const postTaskReview = async (taskId: string): Promise<PostFollowupResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/review`, {
    method: 'POST', credentials: 'include',
  });
  if (response.status === 404 || response.status === 405) {
    throw new Error('Review is unavailable for this task or server. Refresh the task and update the ProPR server if needed.');
  }
  await handleApiResponse(response);
  return response.json();
};
