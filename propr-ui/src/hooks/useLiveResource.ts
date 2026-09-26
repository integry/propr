/**
 * Push-first read of one resource.
 *
 * The refresh discipline lives in `useLiveRefreshScheduler`, which already
 * coalesces bursts, serializes concurrent reads, pauses while the tab is
 * hidden and recovers on visibility change, reconciles once per reconnect, and
 * polls only while the socket is unavailable. This hook contributes the two
 * things that scheduler cannot know: which pushed events matter, and where the
 * result is stored.
 *
 * Declaring the interest here rather than writing an `onActivityUpdate` effect
 * at each call site makes the repository filter a property of the subscription
 * instead of a habit — and the filter runs before any request is issued, which
 * is the entire point: discovering that an event was irrelevant must not cost a
 * round trip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '../contexts/useSocket';
import { useLiveRefreshScheduler } from './useLiveRefreshScheduler';
import type { ActivityChange, ActivityDomain, ActivityUpdatePayload } from '@propr/shared';

/** Scope value meaning "every repository". */
export const ALL_SCOPES = 'all';

/** What a consumer cares about, declared once instead of filtered ad hoc. */
export interface LiveResourceInterest {
  /** Activity domains that should trigger a refresh; omitted means every domain. */
  domains?: readonly ActivityDomain[];
  /** Narrow further to specific changes, e.g. only the terminal ones. */
  changes?: readonly ActivityChange[];
  /** `all`, or `owner/repo`. An event for another repository is dropped here. */
  repository?: string;
  /** Also refresh on goal transitions, which no task update reports. */
  goals?: boolean;
}

export interface LiveResourceOptions<T> {
  /** The existing read. Receives an `AbortSignal` so a stale scope can be cut off. */
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
  /** Skip entirely (e.g. demo mode, or a route that has no id yet). */
  disabled?: boolean;
}

export interface LiveResource<T> {
  data: T | null;
  error: string | null;
  /** No data and no error yet: the first read of this scope is still in flight. */
  loading: boolean;
  /** True while a read is in flight over data that is already on screen. */
  refreshing: boolean;
  /** Force an immediate read, for a retry control. */
  refreshNow: () => void;
}

const DEFAULT_FALLBACK_INTERVAL_MS = 30_000;

export function matchesLiveInterest(
  payload: ActivityUpdatePayload,
  interest: LiveResourceInterest,
): boolean {
  if (interest.domains && !interest.domains.includes(payload.domain)) return false;
  if (interest.changes && !interest.changes.includes(payload.change)) return false;
  const scope = interest.repository ?? ALL_SCOPES;
  // A null repository is instance-wide and always relevant; anything else must
  // match the scope the caller is showing.
  if (scope !== ALL_SCOPES && payload.repository !== null && payload.repository !== scope) return false;
  return true;
}

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
  } = useSocket();

  const [state, setState] = useState<{ scopeKey: string; data: T | null; error: string | null }>(
    { scopeKey, data: null, error: null },
  );
  const [inFlight, setInFlight] = useState(0);
  const requestRef = useRef(0);
  // Held in refs so a caller passing inline closures cannot restart the
  // subscription, or the scheduler, on every render.
  const readRef = useRef(read);
  readRef.current = read;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const interestRef = useRef(interest);
  interestRef.current = interest;

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = useCallback(async () => {
    if (disabled) return;
    const requestId = ++requestRef.current;
    const scope = scopeRef.current;
    // A read that has been superseded — by a newer request or by a scope change
    // — is cut off rather than left to land on a view that has moved on.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInFlight(count => count + 1);
    try {
      const data = await readRef.current(controller.signal);
      // Two guards, because either can invalidate a result: a newer request has
      // been issued, or the scope moved on while this one was in flight.
      if (requestId !== requestRef.current || scope !== scopeRef.current) return;
      setState({ scopeKey: scope, data, error: null });
    } catch (error) {
      if (requestId !== requestRef.current || scope !== scopeRef.current) return;
      // Keep the last good data on screen. A failed refresh is not evidence
      // that the work disappeared, so blanking the view would be a lie.
      setState(previous => ({
        scopeKey: scope,
        data: previous.scopeKey === scope ? previous.data : null,
        error: (error as Error)?.message || 'Request failed',
      }));
    } finally {
      setInFlight(count => Math.max(0, count - 1));
    }
  }, [disabled]);

  const scheduler = useLiveRefreshScheduler({
    isConnected,
    refresh,
    scopeKey,
    fallbackPollMs: fallbackIntervalMs,
  });
  const { refreshNow } = scheduler;

  // A new scope is a different resource, so previous rows are cleared before
  // the first read of the new scope lands — otherwise another filter's data
  // would flash on screen. The read is immediate rather than coalesced.
  useEffect(() => {
    setState(previous => (previous.scopeKey === scopeKey ? previous : { scopeKey, data: null, error: null }));
    if (!disabled) void refreshNow();
  }, [scopeKey, disabled, refreshNow]);

  // Opt into the activity room only while this hook is mounted and enabled.
  // The provider reference-counts the room and (re-)joins it on connect, so
  // subscribing before the socket is up is both safe and necessary.
  useEffect(() => {
    if (disabled) return;
    subscribeToActivity();
    return () => { unsubscribeFromActivity(); };
  }, [disabled, subscribeToActivity, unsubscribeFromActivity]);

  const wantsGoals = Boolean(interest.goals);

  // Registering the listeners does not depend on the connection: a callback
  // registry costs nothing while the socket is down, and re-registering on
  // every connection flap would be churn for no behaviour.
  useEffect(() => {
    if (disabled) return;
    const unsubscribers = [
      onActivityUpdate(payload => {
        // Filtered before scheduling: an irrelevant event costs nothing.
        if (matchesLiveInterest(payload, interestRef.current)) scheduler();
      }),
    ];
    if (wantsGoals) {
      unsubscribers.push(onGoalUpdate(payload => {
        const scope = interestRef.current.repository ?? ALL_SCOPES;
        if (scope === ALL_SCOPES || payload.repository === null || payload.repository === scope) scheduler();
      }));
    }
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }, [disabled, onActivityUpdate, onGoalUpdate, scheduler, wantsGoals]);

  const current = state.scopeKey === scopeKey ? state : { scopeKey, data: null, error: null };
  return {
    data: current.data,
    error: current.error,
    loading: current.data === null && current.error === null,
    refreshing: inFlight > 0,
    refreshNow: useCallback(() => { void refreshNow(); }, [refreshNow]),
  };
}
