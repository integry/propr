// Dashboard data layer: attention, active work, outcomes and historical stats.
//
// The dashboard reads three sources of truth: task state (what needs attention
// and what is running), outcome events (what just happened) and aggregated
// execution data (are things generally going well). Attention never reflects
// notification read or dismissal state — dismissing a notification in the inbox
// must not resolve a blocker.
import { API_BASE_URL, apiFetch, handleApiResponse, shareInFlightApiRead } from './apiClient';

/** `all`, or an `owner/repo` string. */
export type RepositoryFilter = string;

export interface DashboardSummaryResponse {
  repository: RepositoryFilter;
  needsAttention: number;
  running: number;
  queued: number;
  completedRecently: number;
  recentWindowHours: number;
}

export type AttentionCategory = 'blocked' | 'decision';
export type AttentionKind = 'task_failed' | 'task_action_required' | 'plan_review';

export interface AttentionItem {
  id: string;
  category: AttentionCategory;
  kind: AttentionKind;
  taskId: string | null;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  title: string | null;
  state: string;
  detail: string | null;
  /** When the item started needing attention; the list is ordered oldest first. */
  since: string;
}

export interface DashboardAttentionResponse {
  repository: RepositoryFilter;
  items: AttentionItem[];
  counts: { blocked: number; decisions: number; total: number };
}

export interface ActiveItem {
  id: string;
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  title: string | null;
  state: string;
  /** Phase label from real lifecycle state. There is no percentage progress. */
  phase: string | null;
  /** Latest meaningful progress line, or null when the backend does not know one. */
  progressLine: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardQueueSummary {
  queuedCount: number;
  /** Null unless the backend genuinely knows why work is waiting. Never an ETA. */
  reason: string | null;
}

export interface DashboardActiveResponse {
  repository: RepositoryFilter;
  running: ActiveItem[];
  queued: ActiveItem[];
  queue: DashboardQueueSummary;
  counts: { running: number; queued: number };
}

/** Run results plus the later review results recorded against a plan issue. */
export type OutcomeKind = 'completed' | 'failed' | 'cancelled' | 'merged' | 'closed';

export interface OutcomeItem {
  id: string;
  kind: OutcomeKind;
  taskId: string | null;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  title: string | null;
  detail: string | null;
  planIssueStatus: string | null;
  /** Implementation critique score out of 10; null whenever none was recorded. */
  score: number | null;
  occurredAt: string;
}

export interface DashboardOutcomesResponse {
  repository: RepositoryFilter;
  limit: number;
  items: OutcomeItem[];
}

export type DashboardStatsPeriod = '7d' | '30d';

export interface DashboardStatsTotals {
  completed: number | null;
  /** Percentage over finished work only; null when nothing finished. */
  successRate: number | null;
  /** Spend actually recorded against executions; null when none was recorded. */
  recordedSpend: number | null;
}

export interface DashboardStatsResponse extends DashboardStatsTotals {
  period: DashboardStatsPeriod;
  repository: RepositoryFilter;
  dailyCompleted: Array<{ date: string; count: number }>;
  previous: DashboardStatsTotals;
}

const repositoryQuery = (repository: RepositoryFilter): string =>
  `repository=${encodeURIComponent(repository)}`;

const readJson = async <T>(path: string, signal: AbortSignal): Promise<T> => {
  const response = await apiFetch(`${API_BASE_URL}${path}`, { credentials: 'include', signal });
  await handleApiResponse(response);
  return response.json() as Promise<T>;
};

// Dashboard sections mount together, so concurrent reads of the same endpoint
// and filter are shared rather than duplicated.
export const getDashboardSummary = (repository: RepositoryFilter = 'all'): Promise<DashboardSummaryResponse> =>
  shareInFlightApiRead(`dashboard-summary:${repository}`, signal =>
    readJson<DashboardSummaryResponse>(`/api/dashboard/summary?${repositoryQuery(repository)}`, signal));

export const getDashboardAttention = (repository: RepositoryFilter = 'all'): Promise<DashboardAttentionResponse> =>
  shareInFlightApiRead(`dashboard-attention:${repository}`, signal =>
    readJson<DashboardAttentionResponse>(`/api/dashboard/attention?${repositoryQuery(repository)}`, signal));

export const getDashboardActive = (repository: RepositoryFilter = 'all'): Promise<DashboardActiveResponse> =>
  shareInFlightApiRead(`dashboard-active:${repository}`, signal =>
    readJson<DashboardActiveResponse>(`/api/dashboard/active?${repositoryQuery(repository)}`, signal));

export const getDashboardOutcomes = (
  repository: RepositoryFilter = 'all',
  limit?: number,
): Promise<DashboardOutcomesResponse> => {
  const query = limit === undefined
    ? repositoryQuery(repository)
    : `${repositoryQuery(repository)}&limit=${encodeURIComponent(String(limit))}`;
  return shareInFlightApiRead(`dashboard-outcomes:${repository}:${limit ?? 'default'}`, signal =>
    readJson<DashboardOutcomesResponse>(`/api/dashboard/outcomes?${query}`, signal));
};

export const getDashboardStats = (
  repository: RepositoryFilter = 'all',
  period: DashboardStatsPeriod = '7d',
): Promise<DashboardStatsResponse> =>
  shareInFlightApiRead(`dashboard-stats:${repository}:${period}`, signal =>
    readJson<DashboardStatsResponse>(
      `/api/stats/dashboard?${repositoryQuery(repository)}&period=${encodeURIComponent(period)}`,
      signal,
    ));
