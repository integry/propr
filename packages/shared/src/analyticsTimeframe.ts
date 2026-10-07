/**
 * Timeframes the Analytics page can scope its sections to.
 *
 * The API validates the `period` query parameter against this list and the UI
 * renders its selector from it, so the two surfaces cannot drift.
 */

export const ANALYTICS_TIMEFRAMES = ['24h', '7d', '30d', '90d', '1y', 'all'] as const;
export type AnalyticsTimeframe = typeof ANALYTICS_TIMEFRAMES[number];

/** Matches the 30-day activity window the page showed before it had a selector. */
export const DEFAULT_ANALYTICS_TIMEFRAME: AnalyticsTimeframe = '30d';

export const ANALYTICS_TIMEFRAME_LABELS: Record<AnalyticsTimeframe, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '1y': 'Last 12 months',
  all: 'All time',
};

/** Compact labels for the segmented control. */
export const ANALYTICS_TIMEFRAME_SHORT_LABELS: Record<AnalyticsTimeframe, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  '1y': '1y',
  all: 'All',
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Window length in milliseconds; null for all time, which has no lower bound. */
export const ANALYTICS_TIMEFRAME_DURATION_MS: Record<AnalyticsTimeframe, number | null> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  '1y': 365 * DAY_MS,
  all: null,
};

/**
 * Windows read in whole UTC days: "7 days" is today and the six days before
 * it, so a daily chart over the window has exactly seven bars. A rolling
 * 7 × 24h window would touch eight calendar days and draw eight.
 */
const WHOLE_DAY_TIMEFRAMES: ReadonlySet<AnalyticsTimeframe> = new Set(['7d', '30d', '90d', '1y']);

export function isAnalyticsTimeframe(value: unknown): value is AnalyticsTimeframe {
  return typeof value === 'string' && (ANALYTICS_TIMEFRAMES as readonly string[]).includes(value);
}

/** Reads a timeframe from untrusted input, falling back to the default. */
export function parseAnalyticsTimeframe(value: unknown): AnalyticsTimeframe {
  return isAnalyticsTimeframe(value) ? value : DEFAULT_ANALYTICS_TIMEFRAME;
}

/**
 * Start of the window ending at `now`; null for all time. Day timeframes
 * start at UTC midnight, `days - 1` days before today; `24h` is rolling.
 */
export function analyticsTimeframeStart(timeframe: AnalyticsTimeframe, now: Date): Date | null {
  const duration = ANALYTICS_TIMEFRAME_DURATION_MS[timeframe];
  if (duration === null) return null;
  if (!WHOLE_DAY_TIMEFRAMES.has(timeframe)) return new Date(now.getTime() - duration);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - duration + DAY_MS);
}
