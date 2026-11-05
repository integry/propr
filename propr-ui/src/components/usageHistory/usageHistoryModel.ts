/**
 * Shared vocabulary for the Agent Tank usage charts: the Analytics usage chart
 * and the sidebar's per-metric overlay read history through the same helpers so
 * a series has one identity, one label and one color wherever it is drawn.
 */

import { agentTankCyclePeriodMs } from '@propr/shared';
import type { AgentTankHistoryAgent, AgentTankHistoryPoint, AgentTankHistorySeries } from '../../api/revertApi';
import { getProviderDisplayName, getProviderRank } from '../agentTankMetrics';
import { getModelDisplayName } from '../../utils/modelDisplay';
import { stripRemainingSuffix } from '../../utils/usageMetricLabels';

/**
 * Categorical slots in fixed order (validated: adjacent CVD ΔE ≥ 9.1, normal
 * vision ≥ 19.6 on the white surface). Aqua, yellow and magenta sit under 3:1
 * contrast, so every chart that uses them ships a legend with values and a
 * table view. Past the eighth series the hues repeat with a dash pattern, so
 * every series can be drawn without two lines looking alike.
 */
export const USAGE_SERIES_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

/** Stroke patterns for each further round of the palette; solid comes first. */
export const USAGE_SERIES_DASHES = [undefined, '6 4', '2 3', '10 3 2 3'] as const;

/** How a series is drawn: its hue, and a dash pattern once the hues run out. */
export interface UsageSeriesStyle {
  color: string;
  dash?: string;
}

/** Stable identity of one agent's metric series. */
export function usageSeriesId(agent: string, key: string): string {
  return `${agent}:${key}`;
}

// Claude's and Codex's metric keys read better as the sidebar's short names.
const METRIC_LABELS: Record<string, string> = {
  session: 'Session',
  weeklyAll: 'Weekly',
  weeklyFable: 'Fable',
  weeklySonnet: 'Sonnet',
  weekly: 'Weekly',
  fiveHour: 'Session',
};

type SeriesNaming = Pick<AgentTankHistorySeries, 'key' | 'label' | 'model'>;

// Antigravity quota pools carry product wording ("Claude and GPT · Weekly
// Limit", "Gemini 4 Argon Weekly Limit") that a model formatter would mangle.
const isQuotaName = (name: string) => name.includes(' · ') || /\sLimit$/i.test(name);

/**
 * The series' full label, with any model identifier in it shown by its display
 * name, as the sidebar shows it: an Antigravity `model:` series is labelled by
 * its model id ("gemini-2.5-pro" → "Gemini 2.5 Pro"), a Codex per-model limit
 * by the model followed by its window.
 */
export function readableSeriesLabel(series: SeriesNaming): string {
  const label = series.label || series.key;
  if (series.key.startsWith('model:')) {
    const quotaName = stripRemainingSuffix(label);
    return isQuotaName(quotaName) ? quotaName : stripRemainingSuffix(getModelDisplayName(label));
  }
  if (series.model && series.key.startsWith(`${series.model}:`) && label.startsWith(`${series.model} `)) {
    return stripRemainingSuffix(`${getModelDisplayName(series.model)}${label.slice(series.model.length)}`);
  }
  return stripRemainingSuffix(label);
}

/** Short label of a series within its agent ("Session", "Gemini 4 Argon Weekly"). */
export function usageMetricLabel(series: SeriesNaming): string {
  if (METRIC_LABELS[series.key]) return METRIC_LABELS[series.key];
  return readableSeriesLabel(series).replace(/\s+Limit$/i, '');
}

/** Full label naming the agent too ("Claude · Session"). */
export function usageSeriesLabel(agent: string, series: SeriesNaming): string {
  return `${getProviderDisplayName(agent)} · ${usageMetricLabel(series)}`;
}

export interface FlatUsageSeries extends AgentTankHistorySeries {
  id: string;
  agent: string;
  displayLabel: string;
}

/** Every series of a history answer, flattened in provider order. */
export function flattenUsageHistory(agents: AgentTankHistoryAgent[]): FlatUsageSeries[] {
  return [...agents]
    .sort((a, b) => getProviderRank(a.agent) - getProviderRank(b.agent))
    .flatMap(entry => entry.series.map(series => ({
      ...series,
      id: usageSeriesId(entry.agent, series.key),
      agent: entry.agent,
      displayLabel: usageSeriesLabel(entry.agent, series),
    })));
}

/**
 * The style of the series at `index` in a stable ordering of every known id
 * (not of the visible ones), so hiding a series never repaints the others. The
 * first eight are solid; each later round of eight reuses the hues with the
 * next dash pattern, so every series gets a style no other one has (up to 32,
 * past which the rounds repeat; the legend's labels still tell them apart).
 */
export function usageSeriesStyle(index: number): UsageSeriesStyle {
  const hues = USAGE_SERIES_COLORS.length;
  const color = USAGE_SERIES_COLORS[index % hues];
  const dash = USAGE_SERIES_DASHES[Math.floor(index / hues) % USAGE_SERIES_DASHES.length];
  return dash ? { color, dash } : { color };
}

/** The overlay's range: the last two periods of the metric's cycle, ending now. */
export function twoPeriodWindow(cycle: string | null | undefined, now: number = Date.now()): {
  since: number; until: number; periodMs: number;
} {
  const periodMs = agentTankCyclePeriodMs(cycle);
  return { since: now - 2 * periodMs, until: now, periodMs };
}

/** Seconds in an Agent Tank countdown ("2h 14m", "3d 4h", "136h 1m", "45m"); null when unreadable. */
export function parseResetCountdown(text: string | undefined): number | null {
  if (!text) return null;
  const units: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };
  let seconds = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])\b/gi)) {
    seconds += Number(match[1]) * units[match[2].toLowerCase()];
    matched = true;
  }
  return matched ? seconds : null;
}

/**
 * Where the current period began, from the live reset countdown when there is
 * one, otherwise one period before `until`.
 */
export function currentPeriodStart(
  window: { until: number; periodMs: number },
  resetsIn?: string,
): number {
  const seconds = parseResetCountdown(resetsIn);
  if (seconds === null || seconds * 1000 > window.periodMs) return window.until - window.periodMs;
  return window.until + seconds * 1000 - window.periodMs;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Axis tick: clock time up to two days, weekday and hour up to four (where a
 * bare date would repeat across neighbouring ticks), a date beyond that.
 */
export function formatHistoryTick(t: number, spanMs: number): string {
  const date = new Date(t);
  if (spanMs <= 2 * DAY_MS) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (spanMs <= 4 * DAY_MS) return date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Tooltip time, always with both date and clock time. */
export function formatHistoryTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The last recorded value at or before `t`, or null before the series starts. */
export function valueAt(points: Array<{ t: number; percent: number }>, t: number): number | null {
  let value: number | null = null;
  for (const point of points) {
    if (point.t > t) break;
    value = point.percent;
  }
  return value;
}

export interface ChartPoint {
  t: number;
  percent: number;
}

export function toChartPoints(
  points: AgentTankHistoryPoint[],
  since: number,
  until: number,
  currentPercent: number,
): ChartPoint[] {
  const plotted = points
    .map(point => ({ t: Date.parse(point.t), percent: point.percent }))
    .filter((point): point is ChartPoint => Number.isFinite(point.t) && typeof point.percent === 'number'
      && point.t >= since && point.t <= until)
    .sort((a, b) => a.t - b.t);
  // Extend to now with the live value, so the line ends where the row's bar is.
  const last = plotted[plotted.length - 1];
  if (!last || last.t < until) plotted.push({ t: until, percent: currentPercent });
  return plotted;
}
