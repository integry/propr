import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useCurrentUser, userHasPermission } from '../contexts/AuthContext';
import {
  MCP_ACCESS_KINDS,
  MCP_ACCESS_OUTCOMES,
  McpAccessLogPermissionError,
  getMcpAccessLogStats,
  getMcpAccessLogs,
  type McpAccessLogEntry,
  type McpAccessLogPagination,
  type McpAccessLogStats,
} from '../api/adminMcpLogsApi';
import { PaginationFooter } from './LlmLogsPageComponents';
import {
  McpLogTable,
  McpLogsBlockingState,
  McpLogsEmptyState,
  McpLogsStats,
} from './McpLogsPageComponents';
import {
  MCP_LOG_FILTER_KEYS,
  MCP_LOG_WINDOWS,
  buildMcpLogQuery,
  hasActiveMcpLogFilters,
  parseMcpLogFilters,
  resolveWindowSince,
  type McpLogFilters,
} from './mcpLogsUtils';

/**
 * The MCP access log: one row per MCP request an operator can audit, with the
 * same shape as the LLM Log page. The whole view is gated on the instance
 * permission the `/api/admin/mcp` endpoints require, so a user without it never
 * issues a request that would only come back 403.
 */

const PAGE_SIZE = 50;

/** The permission `/api/admin/mcp/logs` requires. */
export const MCP_LOG_PERMISSION = 'instance.manage_settings';

const TEXT_FILTERS = [
  { key: 'name', label: 'Tool / resource', placeholder: 'tool name' },
  { key: 'repository', label: 'Repository', placeholder: 'owner/repo' },
  { key: 'client', label: 'Connected app', placeholder: 'client id' },
  { key: 'user', label: 'User', placeholder: 'user id' },
] as const;

const selectClass = 'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 sm:px-3 sm:py-2';
const inputClass = 'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500';

type LogsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied'; message?: string }
  | { kind: 'ready'; entries: McpAccessLogEntry[]; refreshError: string | null };

function resolveLogsState(
  loadedScope: string | null,
  queryScope: string,
  entries: McpAccessLogEntry[],
  failure: { scope: string; message: string; denied: boolean } | null,
): LogsState {
  const current = failure?.scope === queryScope ? failure : null;
  if (current?.denied) return { kind: 'denied', message: current.message };
  if (loadedScope !== queryScope) return current ? { kind: 'error', message: current.message } : { kind: 'loading' };
  // A failed refresh keeps the rows it already has, but never renders as an empty log.
  if (current && entries.length === 0) return { kind: 'error', message: current.message };
  return { kind: 'ready', entries, refreshError: current?.message ?? null };
}

function failureOf(error: unknown, scope: string, fallback: string): { scope: string; message: string; denied: boolean } {
  if (error instanceof McpAccessLogPermissionError) return { scope, message: error.message, denied: true };
  return { scope, message: (error as Error)?.message || fallback, denied: false };
}

const McpLogsPage: React.FC = () => {
  useDocumentTitle('MCP Log');
  const currentUser = useCurrentUser();
  const canRead = userHasPermission(currentUser, MCP_LOG_PERMISSION);
  const [searchParams, setSearchParams] = useSearchParams();

  // Keyed on the query string itself so the filter object is stable across
  // renders: it is a dependency of the loads below.
  const search = searchParams.toString();
  const filters: McpLogFilters = useMemo(() => parseMcpLogFilters(new URLSearchParams(search)), [search]);
  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const queryScope = useMemo(
    () => JSON.stringify([currentPage, filters]),
    [currentPage, filters],
  );

  const [entries, setEntries] = useState<McpAccessLogEntry[]>([]);
  const [pagination, setPagination] = useState<McpAccessLogPagination | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string; denied: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<McpAccessLogStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  // Bumped to re-run both loads without changing the URL (the error state's Retry).
  const [reloadToken, setReloadToken] = useState(0);
  // Below `sm` the identifier filters are behind a toggle so the first rows stay
  // above the fold; from `sm` up they are always shown.
  const [showTextFilters, setShowTextFilters] = useState(false);
  const requestIdRef = useRef(0);
  const statsRequestIdRef = useRef(0);

  // Draft text filters: applied on submit, so a query is not issued per keystroke.
  const [draft, setDraft] = useState(() => filters);
  useEffect(() => { setDraft(filters); }, [filters]);

  const updateSearchParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '' || value === 'all') next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (!canRead) return;
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    let cancelled = false;
    void (async () => {
      try {
        const response = await getMcpAccessLogs(
          buildMcpLogQuery(filters, { page: currentPage, limit: PAGE_SIZE, now: Date.now() }),
        );
        if (cancelled || requestId !== requestIdRef.current) return;
        setEntries(response.data ?? []);
        setPagination(response.pagination ?? null);
        setLoadedScope(queryScope);
        setFailure(null);
      } catch (error) {
        if (cancelled || requestId !== requestIdRef.current) return;
        setFailure(failureOf(error, queryScope, 'Failed to load the MCP access log'));
      } finally {
        if (!cancelled && requestId === requestIdRef.current) setRefreshing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canRead, currentPage, filters, queryScope, reloadToken]);

  useEffect(() => {
    if (!canRead) return;
    const requestId = ++statsRequestIdRef.current;
    setStatsLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        // Both ends come from one clock reading: left open, `until` would default
        // to the server's later clock and push a 30-day window past retention.
        const now = Date.now();
        const response = await getMcpAccessLogStats({ since: resolveWindowSince(filters.window, now), until: now });
        if (cancelled || requestId !== statsRequestIdRef.current) return;
        setStats(response.data ?? null);
        setStatsError(null);
      } catch (error) {
        if (cancelled || requestId !== statsRequestIdRef.current) return;
        // The summary failing on its own must not hide the rows below it.
        setStats(null);
        setStatsError((error as Error)?.message || 'Failed to load the MCP access summary');
      } finally {
        if (!cancelled && requestId === statsRequestIdRef.current) setStatsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canRead, filters.window, reloadToken]);

  const applyDraft = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    updateSearchParams({
      name: draft.name.trim(),
      repository: draft.repository.trim(),
      client: draft.client.trim(),
      user: draft.user.trim(),
      page: '1',
    });
  }, [draft, updateSearchParams]);

  const clearFilters = useCallback(() => {
    updateSearchParams({ ...Object.fromEntries(MCP_LOG_FILTER_KEYS.map(key => [key, null])), page: '1' });
  }, [updateSearchParams]);

  if (!canRead) return <McpLogsBlockingState kind="denied" />;

  const state = resolveLogsState(loadedScope, queryScope, entries, failure);
  if (state.kind !== 'ready') {
    return (
      <McpLogsBlockingState
        kind={state.kind}
        message={state.kind === 'loading' ? undefined : state.message}
        onRetry={state.kind === 'error' ? () => setReloadToken(token => token + 1) : undefined}
        // A rejected filter would fail again on Retry, so offer a way out of it.
        onClearFilters={state.kind === 'error' && hasActiveMcpLogFilters(filters) ? clearFilters : undefined}
      />
    );
  }

  const totalPages = pagination?.totalPages || 1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-gray-200 bg-slate-50 px-4 py-2 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
          <h1 className="flex-shrink-0 text-lg font-bold text-gray-800 sm:text-2xl">MCP Log</h1>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Filter size={16} className="hidden text-gray-500 sm:block" aria-hidden="true" />
            <select
              aria-label="Time window"
              value={filters.window}
              onChange={event => updateSearchParams({ window: event.target.value, page: '1' })}
              className={selectClass}
            >
              {MCP_LOG_WINDOWS.map(option => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
            <select
              aria-label="Outcome"
              value={filters.outcome}
              onChange={event => updateSearchParams({ outcome: event.target.value, page: '1' })}
              className={selectClass}
            >
              <option value="all">All outcomes</option>
              {MCP_ACCESS_OUTCOMES.map(outcome => (
                <option key={outcome} value={outcome}>{outcome[0].toUpperCase() + outcome.slice(1)}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowTextFilters(current => !current)}
              aria-expanded={showTextFilters}
              aria-controls="mcp-log-filters"
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm font-medium text-gray-700 sm:hidden"
            >
              Filters
            </button>
            <select
              aria-label="Kind"
              value={filters.kind}
              onChange={event => updateSearchParams({ kind: event.target.value, page: '1' })}
              className={selectClass}
            >
              <option value="all">All kinds</option>
              {MCP_ACCESS_KINDS.map(kind => (
                <option key={kind} value={kind}>{kind[0].toUpperCase() + kind.slice(1)}</option>
              ))}
            </select>
          </div>
        </div>
        <form
          id="mcp-log-filters"
          onSubmit={applyDraft}
          aria-label="MCP log filters"
          className={`mt-2 flex-wrap items-end gap-2 ${showTextFilters ? 'flex' : 'hidden sm:flex'}`}
        >
          {TEXT_FILTERS.map(field => (
            <label key={field.key} className="min-w-[8rem] flex-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {field.label}
              <input
                type="search"
                value={draft[field.key]}
                placeholder={field.placeholder}
                onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))}
                className={`mt-1 font-normal normal-case tracking-normal ${inputClass}`}
              />
            </label>
          ))}
          <button
            type="submit"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-teal-500"
          >
            Apply
          </button>
          {hasActiveMcpLogFilters(filters) && (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-md px-2 py-1.5 text-sm font-medium text-teal-700 transition-colors hover:text-teal-900 focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              Clear filters
            </button>
          )}
        </form>
      </div>

      <div className="flex-1 overflow-auto">
        <McpLogsStats stats={stats} error={statsError} loading={statsLoading} />
        {state.refreshError && (
          <div role="alert" className="mx-4 mt-4 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700 sm:mx-6">
            Couldn’t refresh the MCP access log: {state.refreshError}
          </div>
        )}
        {refreshing && <div role="status" className="px-4 pt-3 text-xs text-slate-500 sm:px-6">Refreshing MCP access log…</div>}
        {state.entries.length === 0
          ? <McpLogsEmptyState filtered={hasActiveMcpLogFilters(filters)} onClearFilters={clearFilters} />
          : <McpLogTable entries={state.entries} />}
      </div>

      {state.entries.length > 0 && totalPages > 1 && pagination && (
        <PaginationFooter
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={PAGE_SIZE}
          pagination={pagination}
          loading={refreshing}
          onPageChange={page => updateSearchParams({ page: String(page) })}
        />
      )}
    </div>
  );
};

export default McpLogsPage;
