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
 * only records the error. Nothing announces the dropped connection — the rows
 * that stay on screen are the behaviour, and the next successful read replaces
 * them.
 */
export function useDashboardSection<T>(
  load: () => Promise<T>,
  scope: string,
  refreshToken: number,
): DashboardSection<T> {
  const [state, setState] = useState<SectionState<T>>({ scope, data: null, error: null });
  const [retryToken, setRetryToken] = useState(0);
  const requestRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const requestId = ++requestRef.current;
    setState(previous => (previous.scope === scope ? previous : { scope, data: null, error: null }));
    void loadRef.current().then(
      data => {
        if (requestId !== requestRef.current) return;
        setState({ scope, data, error: null });
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

/**
 * Directory paths in a progress line collapsed to their file name.
 *
 * `Editing propr-ui/src/components/Dashboard/HappeningNowSection.tsx` is a
 * useful thing to read at 1440px and three wrapped lines of dense monospace on
 * a 390px screen. The file is the fact; the route to it is not, to someone who
 * is triaging rather than reviewing.
 *
 * Only tokens with at least two separators are touched, because `src/retry.ts`
 * is already as short as `…/retry.ts` and loses information to say it.
 */
export function shortenPaths(text: string): string {
  return text.replace(/\S+\/\S+\/\S+/g, match => `…/${match.slice(match.lastIndexOf('/') + 1)}`);
}

/** Where a progress sentence stops being its primary action. */
const CLAUSE_BREAK = /(?:,|;| and | then | while | before | after )\s*/i;

/**
 * The first clause of a progress line, for viewports that can only show one.
 *
 * Collapsing the paths in `Editing …/HappeningNowSection.tsx and re-running the
 * dashboard section suite` still leaves more sentence than a 390px row can
 * draw, so the clamp cut it at `and re…` — which reads as a string that was
 * sliced by accident rather than as a line that was shortened on purpose.
 *
 * A phone gets the primary action and the file it names, and stops there. The
 * trailing clause is not lost: the wider viewport still renders the whole
 * sentence, and so does the task the row links to.
 */
export function primaryClause(text: string): string {
  const match = CLAUSE_BREAK.exec(text);
  return match ? text.slice(0, match.index).trim() : text;
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
