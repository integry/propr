import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityChange,
  ActivityDomain,
  ActivityUpdatePayload,
  GoalUpdatePayload,
} from '@propr/shared';
import { useSocket } from '../contexts/useSocket';
import { useLiveRefreshScheduler } from './useLiveRefreshScheduler';

/** What a consumer cares about, declared once instead of filtered ad hoc. */
export interface LiveResourceInterest {
  /** Activity domains that should trigger a refresh. */
  domains?: readonly ActivityDomain[];
  /** Narrow further to specific changes, e.g. only terminal ones. */
  changes?: readonly ActivityChange[];
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
  scopeKey: string;
  interest: LiveResourceInterest;
  /**
   * Interval used ONLY while the socket is disconnected. Push is the normal
   * path; this exists so a client with no websocket degrades to the previous
   * behaviour instead of silently going stale.
   */
  fallbackIntervalMs?: number;
  /** Skip entirely (e.g. demo mode, unauthenticated). */
  disabled?: boolean;
}

export interface LiveResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Force an immediate read, for a retry button. */
  refreshNow: () => void;
}

interface ResourceState<T> {
  scopeKey: string;
  data: T | null;
  error: string | null;
  /** A read for this scope has settled, successfully or not. */
  settled: boolean;
}

const DEFAULT_FALLBACK_INTERVAL_MS = 30_000;

const emptyState = <T,>(scopeKey: string): ResourceState<T> =>
  ({ scopeKey, data: null, error: null, settled: false });

export function matchesInterest(payload: ActivityUpdatePayload, interest: LiveResourceInterest): boolean {
  if (interest.domains && !interest.domains.includes(payload.domain)) return false;
  if (interest.changes && !interest.changes.includes(payload.change)) return false;
  const scope = interest.repository ?? 'all';
  // A null repository is instance-wide and always relevant; anything else must
  // match the scope the caller is showing.
  if (scope !== 'all' && payload.repository !== null && payload.repository !== scope) return false;
  return true;
}

/**
 * Push-first read of one resource.
 *
 * The refresh discipline lives in `useLiveRefreshScheduler`, which already
 * coalesces bursts, serializes concurrent reads, pauses while the tab is
 * hidden and recovers on visibility change, polls only while disconnected, and
 * discards work belonging to a superseded scope. This hook contributes the two
 * things that scheduler cannot know: which events matter, and where the result
 * is stored.
 */
export function useLiveResource<T>({
  read,
  scopeKey,
  interest,
  fallbackIntervalMs = DEFAULT_FALLBACK_INTERVAL_MS,
  disabled = false,
}: LiveResourceOptions<T>): LiveResource<T> {
  const {
    isConnected,
    subscribeToActivity,
    unsubscribeFromActivity,
    onActivityUpdate,
    onGoalUpdate,
    onNotificationUpdate,
    onUsageUpdate,
  } = useSocket();

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
    // Two guards on every settlement, because both can invalidate a result: a
    // newer request has been issued, or the scope moved on while this one was
    // in flight.
    const superseded = () => !mountedRef.current
      || requestId !== requestRef.current
      || scope !== scopeRef.current;
    try {
      const data = await readRef.current(controller.signal);
      if (superseded()) return;
      setState({ scopeKey: scope, data, error: null, settled: true });
    } catch (error) {
      if (superseded()) return;
      const message = (error as Error)?.message || 'Request failed';
      // Keep the last good data on screen. A failed refresh is not evidence
      // that the work disappeared, so blanking the section would be a lie.
      setState(previous => (previous.scopeKey === scope
        ? { ...previous, error: message, settled: true }
        : { scopeKey: scope, data: null, error: message, settled: true }));
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
    fallbackPollMs: fallbackIntervalMs,
  });
  const scheduleRefreshNow = schedule.refreshNow;

  const refreshNow = useCallback(() => {
    void scheduleRefreshNow();
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
    subscribeToActivity();
    return () => { unsubscribeFromActivity(); };
  }, [disabled, subscribeToActivity, unsubscribeFromActivity]);

  const { goals, notifications, usage } = interest;
  useEffect(() => {
    if (disabled) return;
    const unsubscribers: Array<() => void> = [
      onActivityUpdate((payload: ActivityUpdatePayload) => {
        // Filtered before scheduling: an irrelevant event must cost nothing.
        if (matchesInterest(payload, interestRef.current)) schedule();
      }),
    ];
    if (goals) {
      unsubscribers.push(onGoalUpdate((payload: GoalUpdatePayload) => {
        const scope = interestRef.current.repository ?? 'all';
        if (scope === 'all' || payload.repository === scope) schedule();
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
    goals,
    notifications,
    usage,
    onActivityUpdate,
    onGoalUpdate,
    onNotificationUpdate,
    onUsageUpdate,
    schedule,
  ]);

  // The render that introduces a new scope happens before the effect that
  // clears the previous scope's rows, so the stale state is ignored here too -
  // otherwise another filter's data would be visible for one frame.
  const current = state.scopeKey === scopeKey ? state : emptyState<T>(scopeKey);
  return useMemo(() => ({
    data: current.data,
    error: current.error,
    loading: !disabled && !current.settled,
    refreshNow,
  }), [current.data, current.error, current.settled, disabled, refreshNow]);
}
