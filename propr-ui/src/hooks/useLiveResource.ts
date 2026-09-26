import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityChange, ActivityDomain, ActivityUpdatePayload } from '@propr/shared';
import { useSocket } from '../contexts/useSocket';
import { useLiveRefreshScheduler } from './useLiveRefreshScheduler';

/**
 * What a surface wants to be told about.
 *
 * Declaring an interest is how a read stops being a timer: the resource is
 * re-read because the thing it reads actually changed, not because a minute
 * passed. Domains are matched against the derived `activity:update` envelope;
 * `usage` and `notifications` subscribe to the two dedicated trigger events.
 */
export interface LiveResourceInterest {
  /** Activity domains whose changes require a re-read. */
  domains?: readonly ActivityDomain[];
  /** Narrows the domains above to these kinds of change. */
  changes?: readonly ActivityChange[];
  /** Re-read on `usage:update`. */
  usage?: boolean;
  /** Re-read on `notification:update`. */
  notifications?: boolean;
}

export interface LiveResourceOptions<T> {
  /** The authenticated read this surface already owned; the signal cuts off a superseded one. */
  read: (signal: AbortSignal) => Promise<T>;
  /** Identifies the data being read. Changing it drops pending work and starts over. */
  scopeKey?: unknown;
  interest: LiveResourceInterest;
  coalesceMs?: number;
  fallbackPollMs?: number;
}

export interface LiveResource<T> {
  data: T | null;
  error: Error | null;
  /** True until the first read settles, so a widget can stay out of the way. */
  isLoading: boolean;
  /** User-initiated read, without the coalescing delay. */
  refreshNow: () => Promise<void>;
}

/** Whether a pushed activity envelope is one this interest asked for. */
export function matchesInterest(
  interest: LiveResourceInterest,
  payload: ActivityUpdatePayload,
): boolean {
  if (!interest.domains?.includes(payload.domain)) return false;
  if (interest.changes && !interest.changes.includes(payload.change)) return false;
  return true;
}

/**
 * A read that refreshes because the server said its data changed.
 *
 * The robustness contract lives here once rather than in every surface:
 * exactly one reconcile per connect/reconnect transition, no requests while
 * the tab is hidden, interval polling only while the websocket is unavailable,
 * and the last good value kept when a refresh fails.
 */
export function useLiveResource<T>({
  read,
  scopeKey,
  interest,
  coalesceMs,
  fallbackPollMs,
}: LiveResourceOptions<T>): LiveResource<T> {
  const { isConnected, onActivityUpdate, onNotificationUpdate, onUsageUpdate } = useSocket();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const readRef = useRef(read);
  const interestRef = useRef(interest);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const scopeKeyRef = useRef(scopeKey);
  readRef.current = read;
  interestRef.current = interest;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const isCurrent = () => mountedRef.current
      && !controller.signal.aborted
      && generation === generationRef.current;
    try {
      const value = await readRef.current(controller.signal);
      if (!isCurrent()) return;
      setData(value);
      setError(null);
    } catch (readError) {
      // A failed refresh keeps the last good value on screen: a transient
      // error must not blank a widget that was showing correct data.
      if (isCurrent()) setError(readError as Error);
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, []);

  const schedule = useLiveRefreshScheduler({
    isConnected,
    refresh,
    coalesceMs,
    fallbackPollMs,
    scopeKey,
  });

  useEffect(() => {
    if (Object.is(scopeKeyRef.current, scopeKey)) return;
    scopeKeyRef.current = scopeKey;
    // Everything read under the old scope is now about the wrong thing.
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setData(null);
    setError(null);
    setIsLoading(true);
  }, [scopeKey]);

  useEffect(() => {
    // A tab that mounts hidden issues nothing; the scheduler holds the pending
    // read and reconciles once the tab becomes visible.
    if (document.visibilityState === 'hidden') {
      schedule();
      return;
    }
    void schedule.refreshNow();
  }, [schedule, scopeKey]);

  useEffect(() => {
    if (!isConnected) return;
    const { domains, usage, notifications } = interestRef.current;
    const unsubscribers: Array<() => void> = [];
    if (domains?.length) {
      unsubscribers.push(onActivityUpdate(payload => {
        if (matchesInterest(interestRef.current, payload)) schedule();
      }));
    }
    if (usage) unsubscribers.push(onUsageUpdate(() => schedule()));
    if (notifications) unsubscribers.push(onNotificationUpdate(() => schedule()));
    return () => { unsubscribers.forEach(unsubscribe => unsubscribe()); };
  }, [isConnected, onActivityUpdate, onNotificationUpdate, onUsageUpdate, schedule]);

  return { data, error, isLoading, refreshNow: schedule.refreshNow };
}
