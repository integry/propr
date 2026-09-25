import type { McpAccessLogParams } from '../api/adminMcpLogsApi';

/**
 * Pure helpers for the MCP access log page: the time windows it offers, the
 * translation between its URL query string and the API's filter parameters,
 * and the value formatting its table and stats header share.
 *
 * No React or browser dependencies, so these are testable on their own.
 */

/** Rendered in place of any value the API did not report. Never a zero. */
export const UNAVAILABLE = '—';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const MCP_LOG_WINDOWS = [
  { key: '1h', label: 'Last hour', ms: HOUR_MS },
  { key: '24h', label: 'Last 24 hours', ms: DAY_MS },
  { key: '7d', label: 'Last 7 days', ms: 7 * DAY_MS },
  // The access log is pruned at 30 days, so this is the widest window the
  // stats endpoint accepts.
  { key: '30d', label: 'Last 30 days', ms: 30 * DAY_MS },
] as const;

export type McpLogWindowKey = typeof MCP_LOG_WINDOWS[number]['key'];

export const DEFAULT_MCP_LOG_WINDOW: McpLogWindowKey = '24h';

export interface McpLogFilters {
  window: McpLogWindowKey;
  outcome: string;
  kind: string;
  name: string;
  repository: string;
  client: string;
  user: string;
}

/** Filter keys as they appear in the page's own query string. */
export const MCP_LOG_FILTER_KEYS = ['window', 'outcome', 'kind', 'name', 'repository', 'client', 'user'] as const;

function isWindowKey(value: string | null): value is McpLogWindowKey {
  return MCP_LOG_WINDOWS.some(option => option.key === value);
}

/** Read the shareable filter set back out of the URL. Unknown values fall back. */
export function parseMcpLogFilters(searchParams: URLSearchParams): McpLogFilters {
  const windowKey = searchParams.get('window');
  return {
    window: isWindowKey(windowKey) ? windowKey : DEFAULT_MCP_LOG_WINDOW,
    outcome: searchParams.get('outcome') || 'all',
    kind: searchParams.get('kind') || 'all',
    name: searchParams.get('name') || '',
    repository: searchParams.get('repository') || '',
    client: searchParams.get('client') || '',
    user: searchParams.get('user') || '',
  };
}

export function mcpLogWindowMs(window: McpLogWindowKey): number {
  return (MCP_LOG_WINDOWS.find(option => option.key === window) ?? MCP_LOG_WINDOWS[1]).ms;
}

/** Start of the selected window, resolved against the clock at request time. */
export function resolveWindowSince(window: McpLogWindowKey, now: number): number {
  return now - mcpLogWindowMs(window);
}

/**
 * The API parameters for one filter set. Every filter composes: each one that
 * is set narrows the same query.
 */
export function buildMcpLogQuery(
  filters: McpLogFilters,
  { page, limit, now }: { page: number; limit: number; now: number },
): McpAccessLogParams {
  const params: McpAccessLogParams = { page, limit, since: resolveWindowSince(filters.window, now) };
  if (filters.outcome !== 'all') params.outcome = filters.outcome;
  if (filters.kind !== 'all') params.kind = filters.kind;
  if (filters.name) params.name = filters.name;
  if (filters.repository) params.repository = filters.repository;
  if (filters.client) params.clientId = filters.client;
  if (filters.user) params.ownerId = filters.user;
  return params;
}

/** True when anything beyond the default window is narrowing the view. */
export function hasActiveMcpLogFilters(filters: McpLogFilters): boolean {
  return filters.outcome !== 'all' || filters.kind !== 'all'
    || Boolean(filters.name || filters.repository || filters.client || filters.user);
}

export function formatMcpTimestamp(occurredAt: number | null | undefined): string {
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return UNAVAILABLE;
  return new Date(occurredAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatMcpDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return UNAVAILABLE;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatMcpBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return UNAVAILABLE;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A count the API reported, or the unavailable marker when it reported none. */
export function formatMcpCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : UNAVAILABLE;
}

/** The name an operator recognises a connected app by, falling back to its id. */
export function clientDisplayName(
  entry: { clientName?: string | null; clientId?: string | null },
): string {
  return entry.clientName || entry.clientId || UNAVAILABLE;
}

/** An outcome as the API sent it, including one this build does not know. */
export type McpOutcomeLike = string | null | undefined;

/**
 * The semantic treatment of one outcome: a completed call is quiet grey, a
 * rejected call is amber (a human has to look at it), a failed call is red.
 */
const OUTCOME_TONE: Record<string, { badge: string; row: string; label: string }> = {
  success: { badge: 'bg-slate-100 text-slate-700', row: '', label: 'Success' },
  denied: { badge: 'border border-amber-300 bg-amber-50 text-amber-800', row: 'bg-amber-50/60', label: 'Denied' },
  error: { badge: 'bg-red-100 text-red-800', row: 'bg-red-50/60', label: 'Error' },
};

const UNKNOWN_TONE = { badge: 'bg-slate-100 text-slate-600', row: '', label: UNAVAILABLE };

export function outcomeTone(outcome: McpOutcomeLike): { badge: string; row: string; label: string } {
  return (outcome && OUTCOME_TONE[outcome]) || UNKNOWN_TONE;
}
