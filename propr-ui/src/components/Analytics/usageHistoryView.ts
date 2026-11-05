/**
 * View state and data shaping for the Analytics usage-history chart.
 *
 * The selection is stored as what is *hidden*, so a metric that first appears
 * after the view was saved (a new Antigravity pool, a newly enabled agent)
 * shows up by default instead of being silently filtered away.
 */

import type { FlatUsageSeries, UsageSeriesStyle } from '../usageHistory/usageHistoryModel';

const HOUR_MS = 60 * 60 * 1000;

export const USAGE_RANGES = ['24h', '3d', '7d', '14d'] as const;
export type UsageRange = typeof USAGE_RANGES[number];
export const DEFAULT_USAGE_RANGE: UsageRange = '7d';

export const USAGE_RANGE_MS: Record<UsageRange, number> = {
  '24h': 24 * HOUR_MS,
  '3d': 3 * 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '14d': 14 * 24 * HOUR_MS,
};

export const USAGE_RANGE_LABELS: Record<UsageRange, string> = {
  '24h': 'Last 24 hours',
  '3d': 'Last 3 days',
  '7d': 'Last 7 days',
  '14d': 'Last 14 days',
};

export const USAGE_PARAMS = {
  range: 'usageRange',
  hiddenAgents: 'usageHideAgents',
  hiddenSeries: 'usageHide',
} as const;

export interface UsageHistoryView {
  range: UsageRange;
  hiddenAgents: Set<string>;
  hiddenSeries: Set<string>;
}

function parseList(value: string | null): Set<string> {
  return new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean));
}

export function parseUsageHistoryView(params: URLSearchParams): UsageHistoryView {
  const range = params.get(USAGE_PARAMS.range);
  return {
    range: (USAGE_RANGES as readonly string[]).includes(range ?? '') ? range as UsageRange : DEFAULT_USAGE_RANGE,
    hiddenAgents: parseList(params.get(USAGE_PARAMS.hiddenAgents)),
    hiddenSeries: parseList(params.get(USAGE_PARAMS.hiddenSeries)),
  };
}

/** Write the view into `params`, omitting every value that is the default. */
export function writeUsageHistoryView(params: URLSearchParams, view: UsageHistoryView): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set(USAGE_PARAMS.range, view.range === DEFAULT_USAGE_RANGE ? '' : view.range);
  set(USAGE_PARAMS.hiddenAgents, [...view.hiddenAgents].join(','));
  set(USAGE_PARAMS.hiddenSeries, [...view.hiddenSeries].join(','));
  return next;
}

export interface PlottedSeries extends FlatUsageSeries, UsageSeriesStyle {
  /** Points as epoch ms, time-ordered. */
  plotted: Array<{ t: number; percent: number }>;
  latest: number | null;
  min: number | null;
  max: number | null;
}

export function toPlottedSeries(series: FlatUsageSeries, style: UsageSeriesStyle): PlottedSeries {
  const plotted = series.points
    .map(point => ({ t: Date.parse(point.t), percent: point.percent }))
    .filter((point): point is { t: number; percent: number } => Number.isFinite(point.t) && typeof point.percent === 'number')
    .sort((a, b) => a.t - b.t);
  const values = plotted.map(point => point.percent);
  return {
    ...series,
    ...style,
    plotted,
    latest: values.length ? values[values.length - 1] : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

export type ChartRow = { t: number } & Record<string, number | null>;

/**
 * One row per distinct timestamp across the visible series, each carrying
 * every series' value at that moment (its last reading at or before it), so the
 * shared tooltip can read all of them from the hovered row. A series is null
 * before its first point and after its last, rather than invented there.
 */
export function buildChartRows(series: PlottedSeries[]): ChartRow[] {
  const times = [...new Set(series.flatMap(entry => entry.plotted.map(point => point.t)))].sort((a, b) => a - b);
  // One cursor per series walks forward with the shared timeline: linear, not
  // a lookup per row.
  const cursors = series.map(() => -1);
  return times.map(t => {
    const row: ChartRow = { t };
    series.forEach((entry, index) => {
      const points = entry.plotted;
      while (cursors[index] + 1 < points.length && points[cursors[index] + 1].t <= t) cursors[index] += 1;
      const inRange = cursors[index] >= 0 && t <= points[points.length - 1].t;
      row[entry.id] = inRange ? points[cursors[index]].percent : null;
    });
    return row;
  });
}
