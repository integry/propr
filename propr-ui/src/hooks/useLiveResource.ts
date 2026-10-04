import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityChange,
  ActivityDomain,
  ActivityUpdatePayload,
  GoalUpdatePayload,
} from '@propr/shared';
import type { ActivityUpdatePayload as ScopedActivityUpdatePayload } from '@propr/shared/dist/activityEvents.js';
import type { ShellSnapshot } from '../contexts/SocketContext';
import { useSocket } from '../contexts/useSocket';
import { CONNECTED_RECONCILE_MS, useLiveRefreshScheduler } from './useLiveRefreshScheduler';

/** Scope value meaning every repository. */
export const ALL_SCOPES = 'all';

/** What a consumer cares about, declared once instead of filtered ad hoc. */
export interface LiveResourceInterest {
  /** Activity domains that should trigger a refresh. */
  domains?: readonly (ActivityDomain | 'system')[];
  /** Narrow further to specific changes, e.g. only terminal ones. */
  changes?: readonly (ActivityChange | 'progressed' | 'read' | 'dismissed' | 'dismissed_all')[];
  /**
   * `all`, or `owner/repo`. An event for another repository is dropped in the
   * client without a request - dropping it here is the whole point of the
   * exercise, because issuing a request to discover it was irrelevant would
   * reintroduce the cost we are removing.
   */
  repository?: string;
  /** Also refresh on goal-shaped events (the Goals console wants these). */
  goals?: boolean;
  /** Also refresh on this user's notification events. */
  notifications?: boolean;
  /** Also refresh on agent usage change triggers. */
  usage?: boolean;
}

export interface LiveResourceOptions<T> {
  /** The existing XHR read. Receives an AbortSignal so a stale scope can be cut off. */
  read: (signal: AbortSignal) => Promise<T>;
  /**
   * Identity of what is being read. A change clears previous data, because rows
   * from another filter are not this scope's data.
   */
  scopeKey?: unknown;
  interest: LiveResourceInterest;
  /**
   * Interval used ONLY while the socket is disconnected. Push is the normal
   * path; this exists so a client with no websocket degrades to the previous
   * behaviour instead of silently going stale.
   */
  fallbackIntervalMs?: number;
  fallbackPollMs?: number;
  coalesceMs?: number;
  /** Skip entirely (e.g. demo mode, unauthenticated). */
  disabled?: boolean;
  /** Replace invalidation reads with a server-owned projection when supported. */
  snapshotResource?: ShellSnapshot['resource'];
}

export interface LiveResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Initial loading alias used by shell widgets. */
  isLoading: boolean;
  /** True while a read for the current scope is in flight. */
  refreshing: boolean;
  /** Force an immediate read, for a retry button. */
  refreshNow: () => Promise<void>;
}

interface ResourceState<T> {
  scopeKey?: unknown;
  data: T | null;
  error: string | null;
  /** A read for this scope has settled, successfully or not. */
  settled: boolean;
  refreshing: boolean;
}

const DEFAULT_FALLBACK_INTERVAL_MS = 30_000;

const emptyState = <T,>(scopeKey: unknown): ResourceState<T> =>
  ({ scopeKey, data: null, error: null, settled: false, refreshing: false });

export function matchesInterest(payload: ActivityUpdatePayload | ScopedActivityUpdatePayload, interest: LiveResourceInterest): boolean {
  if (!interest.domains?.includes(payload.domain)) return false;
  // The target branch calls health snapshots system/progressed; indexing
  // progress still stays excluded from health-only interests.
  const change = payload.domain === 'system' && payload.change === 'progressed' ? 'updated' : payload.change;
  if (interest.changes && !interest.changes.includes(change)) return false;
  const scope = interest.repository ?? ALL_SCOPES;
  // A null repository is instance-wide and always relevant; anything else must
  // match the scope the caller is showing.
  if (scope !== ALL_SCOPES && payload.repository != null && payload.repository !== scope) return false;
  return true;
}

/** Alias retained for consumers of the dashboard activity hook. */
export const matchesLiveInterest = matchesInterest;

/**
 * Push-first read of one resource.
 *
 * The refresh discipline lives in `useLiveRefreshScheduler`, which already
 * coalesces bursts, serializes concurrent reads, pauses while the tab is
 * hidden and recovers on visibility change, polls frequently while disconnected,
 * reconciles occasionally while connected to recover lost publications, and
 * discards work belonging to a superseded scope. This hook contributes the two
 * things that scheduler cannot know: which events matter, and where the result
 * is stored.
 */
export function useLiveResource<T>({
  read,
  scopeKey,
  interest,
  fallbackIntervalMs = DEFAULT_FALLBACK_INTERVAL_MS,
  fallbackPollMs = fallbackIntervalMs,
  coalesceMs,
  disabled = false,
  snapshotResource,
}: LiveResourceOptions<T>): LiveResource<T> {
  const {
    isConnected,
    shellSnapshots,
    onShellSnapshot,
    subscribeToActivity,
    unsubscribeFromActivity,
    onActivityReady,
    onActivityUpdate,
    onGoalUpdate,
    onNotificationUpdate,
    onUsageUpdate,
  } = useSocket();

  const receivesSnapshots = Boolean(snapshotResource && shellSnapshots);
  const [state, setState] = useState<ResourceState<T>>(() => emptyState<T>(scopeKey));
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  // Held in refs so a caller passing an inline closure or object literal cannot
  // restart the subscription, or the scheduler, on every render.
  const readRef = useRef(read);
  readRef.current = read;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const interestRef = useRef(interest);
  interestRef.current = interest;

  const refresh = useCallback(async () => {
    if (disabledRef.current) return;
    const requestId = ++requestRef.current;
    const scope = scopeRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState(previous => ({
      ...(previous.scopeKey === scope ? previous : emptyState<T>(scope)),
      refreshing: true,
    }));
    // Two guards on every settlement, because both can invalidate a result: a
    // newer request has been issued, or the scope moved on while this one was
    // in flight.
    const superseded = () => !mountedRef.current
      || controller.signal.aborted
      || requestId !== requestRef.current
      || scope !== scopeRef.current;
    try {
      const data = await readRef.current(controller.signal);
      if (superseded()) return;
      setState({ scopeKey: scope, data, error: null, settled: true, refreshing: false });
    } catch (error) {
      if (superseded()) return;
      const message = (error as Error)?.message || 'Request failed';
      // Keep the last good data on screen. A failed refresh is not evidence
      // that the work disappeared, so blanking the section would be a lie.
      setState(previous => (previous.scopeKey === scope
        ? { ...previous, error: message, settled: true, refreshing: false }
        : { scopeKey: scope, data: null, error: message, settled: true, refreshing: false }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  // Owns coalescing, visibility pausing, reconnect recovery, disconnected
  // fallback polling and scope-based cancellation.
  const schedule = useLiveRefreshScheduler({
    isConnected,
    refresh,
    scopeKey,
    fallbackPollMs,
    coalesceMs,
    connectedPollMs: disabled || receivesSnapshots ? undefined : CONNECTED_RECONCILE_MS,
  });
  const scheduleRefreshNow = schedule.refreshNow;

  const refreshNow = useCallback(() => {
    return scheduleRefreshNow();
  }, [scheduleRefreshNow]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A read still on the wire when the scope changes is answering the previous
  // question, so it is cut off rather than left to consume a connection.
  useEffect(() => () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, [scopeKey]);

  // A new scope is a different resource, so previous rows are cleared before
  // the first read of the new scope lands - otherwise another filter's data
  // would flash on screen.
  useEffect(() => {
    setState(previous => (previous.scopeKey === scopeKey ? previous : emptyState<T>(scopeKey)));
    if (!disabled) refreshNow();
  }, [scopeKey, disabled, refreshNow]);

  // Opt into the activity room only while this hook is mounted and enabled.
  useEffect(() => {
    if (disabled) return;
    subscribeToActivity?.();
    return () => { unsubscribeFromActivity?.(); };
  }, [disabled, subscribeToActivity, unsubscribeFromActivity]);

  const { goals, notifications, usage } = interest;
  useEffect(() => {
    if (disabled || receivesSnapshots) return;
    const unsubscribers: Array<() => void> = [
      onActivityReady?.(() => schedule()) ?? (() => {}),
      onActivityUpdate((payload: ActivityUpdatePayload) => {
        // Filtered before scheduling: an irrelevant event must cost nothing.
        if (matchesInterest(payload, interestRef.current)) schedule();
      }),
    ];
    if (goals) {
      unsubscribers.push(onGoalUpdate((payload: GoalUpdatePayload) => {
        const scope = interestRef.current.repository ?? ALL_SCOPES;
        if (scope === ALL_SCOPES || payload.repository === null || payload.repository === scope) schedule();
      }));
    }
    if (notifications) {
      unsubscribers.push(onNotificationUpdate(() => { schedule(); }));
    }
    if (usage) {
      unsubscribers.push(onUsageUpdate(() => { schedule(); }));
    }
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }, [
    disabled,
    receivesSnapshots,
    goals,
    notifications,
    usage,
    onActivityReady,
    onActivityUpdate,
    onGoalUpdate,
    onNotificationUpdate,
    onUsageUpdate,
    schedule,
  ]);

  useEffect(() => {
    if (disabled || !snapshotResource) return;
    return onShellSnapshot?.(payload => {
      if (payload.resource !== snapshotResource) return;
      requestRef.current += 1;
      controllerRef.current?.abort();
      setState({ scopeKey, data: payload.data as T, error: null, settled: true, refreshing: false });
    });
  }, [disabled, onShellSnapshot, snapshotResource, scopeKey]);

  // The render that introduces a new scope happens before the effect that
  // clears the previous scope's rows, so the stale state is ignored here too -
  // otherwise another filter's data would be visible for one frame.
  const current = state.scopeKey === scopeKey ? state : emptyState<T>(scopeKey);
  return useMemo(() => ({
    data: current.data,
    error: current.error,
    loading: !disabled && !current.settled,
    isLoading: !disabled && !current.settled,
    refreshing: !disabled && current.refreshing,
    refreshNow,
  }), [current.data, current.error, current.settled, current.refreshing, disabled, refreshNow]);
}
