/**
 * Dashboard section state: reads, ordering and time.
 *
 * Every section shares these rules so they behave the same way under live
 * updates. Nothing here invents progress, percentages or estimates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// The task list owns the relative-time vocabulary; the dashboard reuses it
// rather than growing a second set of duration strings.
import { formatDuration, formatRelativeTime } from '../TaskList/utils.tsx';

/** Query-string key holding the dashboard-wide repository filter. */
export const REPOSITORY_PARAM = 'repository';
export const ALL_REPOSITORIES = 'all';

export interface DashboardSectionProps {
  /** `all`, or an `owner/repo` string. */
  repository: string;
  /** Bumped by the composition root once per coalesced burst of live events. */
  refreshToken: number;
  /** Reports a successful read so the shell can show when data was last fresh. */
  onLoaded?: () => void;
}

interface SectionState<T> {
  scope: string;
  data: T | null;
  error: string | null;
}

export interface DashboardSection<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * One section's read of the dashboard API.
 *
 * A changed scope (repository or a section-local option) clears the previous
 * rows, because rows from another filter are not this section's data. A live
 * refresh never does: a failed refresh keeps the last known rows on screen and
 * only records the error, which is what "reconnecting" has to look like.
 */
export function useDashboardSection<T>(
  load: () => Promise<T>,
  scope: string,
  refreshToken: number,
  onLoaded?: () => void,
): DashboardSection<T> {
  const [state, setState] = useState<SectionState<T>>({ scope, data: null, error: null });
  const [retryToken, setRetryToken] = useState(0);
  const requestRef = useRef(0);
  const loadRef = useRef(load);
  const onLoadedRef = useRef(onLoaded);
  loadRef.current = load;
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    const requestId = ++requestRef.current;
    setState(previous => (previous.scope === scope ? previous : { scope, data: null, error: null }));
    void loadRef.current().then(
      data => {
        if (requestId !== requestRef.current) return;
        setState({ scope, data, error: null });
        onLoadedRef.current?.();
      },
      error => {
        if (requestId !== requestRef.current) return;
        setState(previous => ({
          scope,
          data: previous.scope === scope ? previous.data : null,
          error: (error as Error)?.message || 'Request failed',
        }));
      },
    );
  }, [scope, refreshToken, retryToken]);

  const reload = useCallback(() => setRetryToken(token => token + 1), []);

  // A scope whose read has not landed yet is loading even during the render
  // before its effect runs, so another filter's rows never flash.
  const current = state.scope === scope ? state : { scope, data: null, error: null };
  return {
    data: current.data,
    error: current.error,
    loading: current.data === null && current.error === null,
    reload,
  };
}

/**
 * Display order that survives live updates.
 *
 * Server order decides where a row first appears; after that a row keeps its
 * position for as long as it exists. Running work changes state constantly, and
 * a list that re-sorted on every update would move the row under the pointer.
 */
export function useStableOrder<T>(items: T[], getKey: (item: T) => string): T[] {
  const orderRef = useRef<string[]>([]);
  return useMemo(() => {
    const byKey = new Map<string, T>();
    for (const item of items) byKey.set(getKey(item), item);
    const retained = orderRef.current.filter(key => byKey.has(key));
    const seen = new Set(retained);
    const appended = [...byKey.keys()].filter(key => !seen.has(key));
    const order = [...retained, ...appended];
    orderRef.current = order;
    return order.map(key => byKey.get(key) as T);
  }, [items, getKey]);
}

/** Re-renders on an interval so elapsed times stay honest without polling. */
export function useNowTick(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Elapsed wall-clock time since a timestamp, phrased as a duration.
 * `formatRelativeTime` supplies the wording; only the "ago" framing is dropped.
 */
export function elapsedLabel(since: string): string {
  const relative = formatRelativeTime(since);
  if (!relative || relative === 'Just now') return 'less than a minute';
  return relative.replace(/ ago$/, '');
}

/** Precise elapsed time for running work, where minutes and seconds both matter. */
export const elapsedRunning = (since: string): string => formatDuration(since, null);

/** Links a row to a task, or to GitHub when the work has no task of its own. */
export function workHref(item: {
  taskId?: string | null;
  repository: string;
  issueNumber?: number | null;
  prNumber?: number | null;
}): string {
  if (item.taskId) return `/tasks/${encodeURIComponent(item.taskId)}`;
  if (item.prNumber) return `https://github.com/${item.repository}/pull/${item.prNumber}`;
  if (item.issueNumber) return `https://github.com/${item.repository}/issues/${item.issueNumber}`;
  return '/tasks';
}

export const isExternalHref = (href: string): boolean => /^https?:\/\//i.test(href);

/** Builds a link to the task list filtered the way a dashboard count is. */
export function filteredTasksHref(status: string, repository: string): string {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (repository && repository !== ALL_REPOSITORIES) params.set(REPOSITORY_PARAM, repository);
  const query = params.toString();
  return query ? `/tasks?${query}` : '/tasks';
}
