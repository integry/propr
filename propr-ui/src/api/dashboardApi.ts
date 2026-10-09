// Dashboard data layer: attention, active work, completed work and historical stats.
//
// The dashboard reads three sources of truth: task state (what needs attention
// and what is running), completion events (what was finished) and aggregated
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
export type AttentionKind = 'task_failed' | 'task_action_required' | 'plan_review' | 'goal_blocker';

export interface AttentionItem {
  id: string;
  category: AttentionCategory;
  kind: AttentionKind;
  taskId: string | null;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  /** The task's recorded type (`issue`, `pr-comment`, `review`…), when known. */
  taskType: string | null;
  title: string | null;
  state: string;
  detail: string | null;
  /** When the item started needing attention; the list is ordered newest first. */
  since: string;
  /** Goal blockers only: the goal console to open, and the blocker from the shared goal attention projection. */
  goalId?: string;
  goalBlocker?: {
    id: string;
    category: 'question' | 'approval' | 'paused';
    actionable: boolean;
    responseActions: Array<'send_input' | 'resume' | 'pause' | 'cancel'>;
  };
}

export interface DashboardAttentionResponse {
  repository: RepositoryFilter;
  items: AttentionItem[];
  counts: { blocked: number; decisions: number; total: number };
}

export interface ActiveItem {
  goalId?: string;
  id: string;
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  /** The task's recorded type (`issue`, `pr-comment`, `review`…), when known. */
  taskType: string | null;
  title: string | null;
  state: string;
  /** Phase label from real lifecycle state. There is no percentage progress. */
  phase: string | null;
  /** Latest meaningful progress line, or null when the backend does not know one. */
  progressLine: string | null;
  /** The agent's latest action, from its most recent tool call; null when unknown. */
  activity?: string | null;
  /** Position in the agent's own plan; null when it keeps none. */
  step?: { current: number; total: number } | null;
  /** When the agent last produced output; null when the stream shows none. */
  lastActivityAt?: string | null;
  /**
   * The stream was read and holds no agent output yet. Absent or false when
   * the stream is unknown — unread or unreadable — which is not the same.
   */
  awaitingFirstOutput?: boolean;
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

/**
 * One entity’s newest successful outcome. Failures are attention items,
 * and cancelled or skipped runs are not listed at all.
 */
export interface OutcomeItem {
  entityId?: string;
  revision?: string;
  /** Completed task outcomes rolled up; absent on older servers. */
  eventCount?: number;
  /** Prior completed actions, newest first; excludes the displayed outcome. */
  earlierUpdates?: Array<Omit<OutcomeItem, 'eventCount' | 'earlierUpdates'>>;
  id: string;
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  /** The task's recorded type (`issue`, `pr-comment`, `review`…), when known. */
  taskType: string | null;
  title: string | null;
  /**
   * What the run produced — for a review, what it found. Null when nothing was
   * recorded beyond the fact that it finished.
   */
  detail: string | null;
  /** Review score out of 10. Only reviews are scored; null for everything else. */
  score: number | null;
  occurredAt: string;
}

export interface DashboardOutcomesResponse {
  repository: RepositoryFilter;
  limit: number;
  /** The title search the items were narrowed by; empty for none. */
  search?: string;
  items: OutcomeItem[];
}

export type DashboardStatsPeriod = '7d' | '30d';

export interface DashboardStatsTotals {
  /** Tasks created in the period: the Analytics page's "Total tasks" for the same period. */
  tasks?: number | null;
  completed: number | null;
  /** Percentage over finished work only; null when nothing finished. */
  successRate: number | null;
  /** Spend actually recorded against executions; null when none was recorded. */
  recordedSpend: number | null;
}

export interface DashboardStatsResponse extends DashboardStatsTotals {
  period: DashboardStatsPeriod;
  repository: RepositoryFilter;
  failed?: number | null;
  /** Tasks created per UTC day, the series the Analytics activity chart plots. */
  dailyTasks?: Array<{ date: string; count: number }>;
  /** Daily completions from servers that predate the shared aggregation. */
  dailyCompleted?: Array<{ date: string; count: number }>;
  previous: DashboardStatsTotals;
}

const repositoryQuery = (repository: RepositoryFilter): string =>
  `repository=${encodeURIComponent(repository)}`;

const readJson = async <T>(path: string, signal: AbortSignal, accept = 'application/json'): Promise<T> => {
  const response = await apiFetch(`${API_BASE_URL}${path}`, { credentials: 'include', signal, headers: { Accept: accept } });
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
  search = '',
  view: 'legacy' | 'summary' = 'summary',
): Promise<DashboardOutcomesResponse> => {
  const params = [repositoryQuery(repository)];
  if (limit !== undefined) params.push(`limit=${encodeURIComponent(String(limit))}`);
  const term = search.trim();
  if (term) params.push(`search=${encodeURIComponent(term)}`);
  return shareInFlightApiRead(`dashboard-outcomes:${view}:${repository}:${limit ?? 'default'}:${term}`, signal =>
    readJson<DashboardOutcomesResponse>(`/api/dashboard/outcomes?${params.join('&')}`, signal,
      view === 'summary' ? 'application/vnd.propr.outcome-summaries+json' : 'application/json'));
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

export interface DashboardNarrativeResponse {
  repository: RepositoryFilter;
  enabled: boolean;
  summary: string | null;
}

export const getDashboardNarrative = (
  repository: RepositoryFilter = 'all',
  refresh = false,
): Promise<DashboardNarrativeResponse> =>
  shareInFlightApiRead(`dashboard-narrative:${repository}:${refresh}`, signal =>
    readJson<DashboardNarrativeResponse>(
      `/api/dashboard/narrative?${repositoryQuery(repository)}${refresh ? '&refresh=true' : ''}`, signal,
    ));


export interface OutcomeHistoryPage { items: OutcomeItem[]; nextCursor: string | null }
export class OutcomeHistoryStaleError extends Error {}
export const getDashboardOutcomeHistory = (
  repository: string, entityId: string, revision: string, cursor: string | null = null,
): Promise<OutcomeHistoryPage> => {
  const query = new URLSearchParams({ repository, view: 'history', entityId, revision, limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return shareInFlightApiRead(`dashboard-history:${query}`, async signal => {
    const response = await apiFetch(`${API_BASE_URL}/api/dashboard/outcomes?${query}`, { credentials: 'include', signal });
    if (response.status === 409) throw new OutcomeHistoryStaleError('Updates changed. Refreshing…');
    await handleApiResponse(response);
    return response.json() as Promise<OutcomeHistoryPage>;
  });
};
