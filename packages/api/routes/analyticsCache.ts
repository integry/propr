/**
 * A short-lived memo for the Analytics aggregations that read a PR's whole
 * history: delivery metrics and review quality.
 *
 * A day-bounded period reads only its window and is always computed afresh.
 * The all-time period (and a request with no period) reads every task that
 * opened a PR, every task related to those PRs and every score ever recorded,
 * which on a long-lived instance can take longer than the rest of the
 * overview together; those two aggregations are remembered for a short while
 * per window and repository, so the page's refresh on each task update does
 * not re-read the whole history every time.
 */

import type { AnalyticsWindow } from './analyticsWindow.js';

/** How long an all-time delivery or review-quality aggregation is reused. */
export const ALL_TIME_CACHE_TTL_MS = 60_000;

interface Entry { expires: number; value: Promise<unknown> }

export interface AnalyticsCache {
  /**
   * The aggregation for `window`, loaded now when the window is bounded or
   * when the remembered all-time value has expired. A load that fails is not
   * remembered.
   */
  remember<T>(name: string, window: AnalyticsWindow | null, load: () => Promise<T>): Promise<T>;
}

/** Whether a window reads the whole history rather than a bounded period. */
export const isAllTime = (window: AnalyticsWindow | null): boolean => !window || window.from === null;

export function createAnalyticsCache({ ttlMs = ALL_TIME_CACHE_TTL_MS, now = () => Date.now() }: {
  ttlMs?: number; now?: () => number;
} = {}): AnalyticsCache {
  const entries = new Map<string, Entry>();
  return {
    remember<T>(name: string, window: AnalyticsWindow | null, load: () => Promise<T>): Promise<T> {
      if (!isAllTime(window)) return load();
      const key = `${name}|${window?.timeframe ?? ''}`;
      const current = now();
      const known = entries.get(key);
      if (known && known.expires > current) return known.value as Promise<T>;
      const value = load();
      entries.set(key, { expires: current + ttlMs, value });
      value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
      return value;
    },
  };
}
