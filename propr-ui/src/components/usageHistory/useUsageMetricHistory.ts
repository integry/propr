import { useEffect, useState, useSyncExternalStore } from 'react';
import { getAgentTankHistory, type AgentTankHistorySeries } from '../../api/revertApi';
import { useOptionalSocket } from '../../contexts/useSocket';
import { twoPeriodWindow } from './usageHistoryModel';

/** Re-hovering a row within this long reuses the answer instead of refetching. */
const CACHE_TTL_MS = 60_000;

interface CachedHistory {
  fetchedAt: number;
  since: number;
  until: number;
  series: AgentTankHistorySeries | null;
  enabled: boolean;
}

const cache = new Map<string, CachedHistory>();

/**
 * Set when the backend reports history is off, so closed rows stop offering
 * it. It lapses with the cache, and clears as soon as anything sees Agent Tank
 * enabled again, so re-enabling never needs a reload to bring history back.
 */
let historyDisabled = false;
let disabledExpiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setHistoryDisabled(disabled: boolean): void {
  clearTimeout(disabledExpiry);
  disabledExpiry = disabled ? setTimeout(() => setHistoryDisabled(false), CACHE_TTL_MS) : undefined;
  if (!disabled) {
    // A remembered "off" answer would otherwise keep showing for its TTL.
    for (const [key, entry] of cache) if (!entry.enabled) cache.delete(key);
  }
  if (historyDisabled === disabled) return;
  historyDisabled = disabled;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isUsageHistoryDisabled(): boolean {
  return historyDisabled;
}

/** Re-renders when history becomes unavailable or available again. */
export function useUsageHistoryDisabled(): boolean {
  return useSyncExternalStore(subscribe, isUsageHistoryDisabled);
}

/** Agent Tank reported enabled usage, so history is worth offering again. */
export function noteAgentTankUsageEnabled(): void {
  setHistoryDisabled(false);
}

/** Test-only seam. */
export function resetUsageMetricHistoryCache(): void {
  cache.clear();
  setHistoryDisabled(false);
}

export type UsageMetricHistoryState =
  | { status: 'loading'; since: number; until: number; periodMs: number }
  | { status: 'error'; since: number; until: number; periodMs: number; message: string }
  | { status: 'ready'; since: number; until: number; periodMs: number; series: AgentTankHistorySeries | null; enabled: boolean };

/**
 * One metric's history over its last two periods, read when `active` turns on
 * and read again, past the cache, whenever new usage is recorded while it
 * stays open. The request is aborted if the overlay closes first.
 */
export function useUsageMetricHistory(
  agent: string,
  historyKey: string,
  cycle: string | undefined,
  active: boolean,
): UsageMetricHistoryState | null {
  const [state, setState] = useState<UsageMetricHistoryState | null>(null);
  // Bumped by a usage push while open; zero again once the overlay closes.
  const [revision, setRevision] = useState(0);
  // Rows also render outside the socket provider (Settings' agent cards);
  // there the overlay keeps its one read.
  const onUsageUpdate = useOptionalSocket()?.onUsageUpdate;

  useEffect(() => {
    if (!active) {
      setRevision(0);
      return undefined;
    }
    if (!onUsageUpdate) return undefined;
    // A push means the backend has just recorded a sample, so the cached
    // answer for this metric is behind.
    return onUsageUpdate(() => {
      cache.delete(`${agent}\u0000${historyKey}`);
      setRevision(current => current + 1);
    });
  }, [agent, historyKey, active, onUsageUpdate]);

  useEffect(() => {
    if (!active) return undefined;
    const { since, until, periodMs } = twoPeriodWindow(cycle);
    const cacheKey = `${agent}\u0000${historyKey}`;
    const cached = cache.get(cacheKey);
    if (cached && until - cached.fetchedAt < CACHE_TTL_MS) {
      setState({ status: 'ready', since: cached.since, until: cached.until, periodMs, series: cached.series, enabled: cached.enabled });
      return undefined;
    }
    const controller = new AbortController();
    // A refresh keeps the chart on screen until the newer answer lands.
    setState(current => (revision > 0 && current?.status === 'ready' ? current : { status: 'loading', since, until, periodMs }));
    getAgentTankHistory({ since, until, agents: [agent], metric: historyKey, signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return;
        const series = response.agents
          .find(entry => entry.agent === agent)?.series
          .find(entry => entry.key === historyKey) ?? null;
        cache.set(cacheKey, { fetchedAt: until, since, until, series, enabled: response.enabled });
        setHistoryDisabled(!response.enabled);
        setState({ status: 'ready', since, until, periodMs, series, enabled: response.enabled });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error', since, until, periodMs,
          message: error instanceof Error && error.message ? error.message : 'Could not load usage history',
        });
      });
    return () => controller.abort();
  }, [agent, historyKey, cycle, active, revision]);

  return active ? state : null;
}
