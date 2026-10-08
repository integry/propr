/**
 * A short-lived memo for the Analytics aggregations that read a PR's whole
 * history: delivery metrics, review quality and autonomy.
 *
 * The page refreshes on every task update, and each refresh asks for the
 * same aggregations over the same period, so each is remembered for a short
 * while per window and repository rather than re-read on every request.
 *
 * How long depends on how much the aggregation reads. A day-bounded period
 * reads only its window and is remembered for a few seconds: long enough to
 * absorb a burst of refreshes, short enough that a task update shows within
 * the next refresh or two. The all-time period (and a request with no period)
 * reads every task that opened a PR, every task related to those PRs and
 * every score ever recorded, which on a long-lived instance can take longer
 * than the rest of the overview together; it is remembered for a minute.
 *
 * A bounded window's end is the moment it was requested, so a remembered
 * bounded value is at most its TTL behind the window a later request would
 * have read. Expired entries are dropped whenever the memo is consulted, so a
 * repository-specific entry that is never asked for again does not stay
 * resident for the life of the process.
 */

import type { AnalyticsWindow } from './analyticsWindow.js';

/** How long an all-time aggregation is reused. */
export const ALL_TIME_CACHE_TTL_MS = 60_000;
/** How long a day-bounded aggregation is reused. */
export const BOUNDED_CACHE_TTL_MS = 10_000;

interface Entry { expires: number; value: Promise<unknown> }

export interface AnalyticsCache {
  /**
   * The aggregation for `window`, loaded now when no remembered value for it
   * is still fresh. A load that fails is not remembered.
   */
  remember<T>(name: string, window: AnalyticsWindow | null, load: () => Promise<T>): Promise<T>;
  /** Entries currently held, expired ones included until the next call. */
  readonly size: number;
}

/** Whether a window reads the whole history rather than a bounded period. */
export const isAllTime = (window: AnalyticsWindow | null): boolean => !window || window.from === null;

export function createAnalyticsCache({
  ttlMs = ALL_TIME_CACHE_TTL_MS, boundedTtlMs = BOUNDED_CACHE_TTL_MS, now = () => Date.now(),
}: {
  /** TTL for all-time aggregations. */
  ttlMs?: number;
  /** TTL for day-bounded aggregations; 0 reads them afresh every time. */
  boundedTtlMs?: number;
  now?: () => number;
} = {}): AnalyticsCache {
  const entries = new Map<string, Entry>();
  const evictExpired = (current: number) => {
    for (const [key, entry] of entries) if (entry.expires <= current) entries.delete(key);
  };
  return {
    remember<T>(name: string, window: AnalyticsWindow | null, load: () => Promise<T>): Promise<T> {
      const current = now();
      evictExpired(current);
      const ttl = isAllTime(window) ? ttlMs : boundedTtlMs;
      if (ttl <= 0) return load();
      const key = `${name}|${window?.timeframe ?? ''}`;
      const known = entries.get(key);
      if (known) return known.value as Promise<T>;
      const value = load();
      entries.set(key, { expires: current + ttl, value });
      value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
      return value;
    },
    get size() { return entries.size; },
  };
}
