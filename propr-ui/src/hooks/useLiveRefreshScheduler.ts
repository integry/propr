import { useCallback, useEffect, useRef } from 'react';

interface LiveRefreshSchedulerOptions {
  isConnected: boolean;
  refresh: () => unknown | Promise<unknown>;
  coalesceMs?: number;
  fallbackPollMs?: number;
  /**
   * Identifies the data being refreshed. Pending work from an old scope is
   * discarded when, for example, a detail route navigates to another task.
   */
  scopeKey?: unknown;
}

export interface LiveRefreshScheduler {
  (): void;
  /** Run an initial or user-requested refresh without the coalescing delay. */
  refreshNow: () => Promise<void>;
}

/**
 * Coalesces live invalidations, serializes refreshes, and lets hidden tabs
 * recover once when visible. While the socket is down, a bounded visible-tab
 * poll remains as a freshness fallback.
 */
export function useLiveRefreshScheduler({
  isConnected,
  refresh,
  coalesceMs = 100,
  fallbackPollMs = 30_000,
  scopeKey,
}: LiveRefreshSchedulerOptions): LiveRefreshScheduler {
  const documentIsHidden = () => document.visibilityState === 'hidden';
  const mountedRef = useRef(true);
  const connectedRef = useRef(isConnected);
  const refreshRef = useRef(refresh);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const immediateRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const scopeKeyRef = useRef(scopeKey);
  const previousConnectedRef = useRef<boolean | null>(null);
  connectedRef.current = isConnected;
  refreshRef.current = refresh;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const runRefresh = useCallback(async (generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current) return;
    const existing = inFlightRef.current;
    if (existing?.generation === generation) return existing.promise;

    pendingRef.current = false;
    const promise = Promise.resolve().then(async () => {
      await refreshRef.current();
    });
    inFlightRef.current = { generation, promise };
    try {
      await promise;
    } finally {
      if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
      if (mountedRef.current && generation === generationRef.current && pendingRef.current && !documentIsHidden()) {
        // Invalidations received during the request need one trailing read. It
        // is scheduled through the normal delay so another burst is coalesced.
        if (timerRef.current === null) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (!mountedRef.current || generation !== generationRef.current || !pendingRef.current || documentIsHidden()) return;
            void runRefresh(generation).catch(error => console.error('Live refresh failed:', error));
          }, coalesceMs);
        }
      }
    }
  }, [coalesceMs]);

  const schedule = useCallback(() => {
    const generation = generationRef.current;
    pendingRef.current = true;
    if (documentIsHidden() || timerRef.current !== null || inFlightRef.current?.generation === generation) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!mountedRef.current || generation !== generationRef.current || !pendingRef.current || documentIsHidden()) return;
      void runRefresh(generation).catch(error => console.error('Live refresh failed:', error));
    }, coalesceMs);
  }, [coalesceMs, runRefresh]);

  const refreshNow = useCallback((): Promise<void> => {
    const generation = generationRef.current;
    const existingImmediate = immediateRef.current;
    if (existingImmediate?.generation === generation) return existingImmediate.promise;

    pendingRef.current = true;
    clearTimer();
    const promise = (async () => {
      const existing = inFlightRef.current;
      if (existing?.generation === generation) await existing.promise;
      if (!mountedRef.current || generation !== generationRef.current) return;
      clearTimer();
      if (pendingRef.current) await runRefresh(generation);
    })();
    immediateRef.current = { generation, promise };
    void promise.finally(() => {
      if (immediateRef.current?.promise === promise) immediateRef.current = null;
    }).catch(() => undefined);
    return promise;
  }, [clearTimer, runRefresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  useEffect(() => {
    if (Object.is(scopeKeyRef.current, scopeKey)) return;
    scopeKeyRef.current = scopeKey;
    generationRef.current += 1;
    pendingRef.current = false;
    inFlightRef.current = null;
    immediateRef.current = null;
    clearTimer();
  }, [clearTimer, scopeKey]);

  useEffect(() => {
    const previous = previousConnectedRef.current;
    previousConnectedRef.current = isConnected;
    if (previous === false && isConnected) schedule();
  }, [isConnected, schedule]);

  useEffect(() => {
    const recoverVisible = () => {
      if (!documentIsHidden()) schedule();
    };
    const fallback = window.setInterval(() => {
      if (!connectedRef.current && !documentIsHidden()) schedule();
    }, fallbackPollMs);
    document.addEventListener('visibilitychange', recoverVisible);
    window.addEventListener('focus', recoverVisible);
    return () => {
      window.clearInterval(fallback);
      document.removeEventListener('visibilitychange', recoverVisible);
      window.removeEventListener('focus', recoverVisible);
    };
  }, [fallbackPollMs, schedule]);

  const scheduler = schedule as LiveRefreshScheduler;
  scheduler.refreshNow = refreshNow;
  return scheduler;
}
