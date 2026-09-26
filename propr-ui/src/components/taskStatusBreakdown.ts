import type { StatusDistribution } from '../api/taskStatsApi';

export interface StatusBreakdownEntry {
  /** Stable key for the merged status group. */
  key: string;
  /** Human label matching the vocabulary of the activity feed status pills. */
  name: string;
  value: number;
  /** Share of the total, 0-100, unrounded so slivers never collapse to 0. */
  percent: number;
  color: string;
}

interface StatusGroup {
  key: string;
  name: string;
  color: string;
}

// Hues match the activity feed status pills (utils.tsx getStatusPill) so the bar
// and the rows read as one vocabulary. Completed is deliberately quiet slate.
const STATUS_GROUPS: Record<string, StatusGroup> = {
  completed: { key: 'completed', name: 'Completed', color: '#94A3B8' },
  failed: { key: 'failed', name: 'Failed', color: '#EF4444' },
  cancelled: { key: 'cancelled', name: 'Cancelled', color: '#F97316' },
  active: { key: 'implementing', name: 'Implementing', color: '#14B8A6' },
  implementing: { key: 'implementing', name: 'Implementing', color: '#14B8A6' },
  processing: { key: 'implementing', name: 'Implementing', color: '#14B8A6' },
  claude_execution: { key: 'implementing', name: 'Implementing', color: '#14B8A6' },
  post_processing: { key: 'implementing', name: 'Implementing', color: '#14B8A6' },
  waiting: { key: 'pending', name: 'Pending', color: '#A855F7' },
  pending: { key: 'pending', name: 'Pending', color: '#A855F7' },
  queued: { key: 'pending', name: 'Pending', color: '#A855F7' },
  planning: { key: 'planning', name: 'Planning', color: '#EC4899' },
};

const FALLBACK_COLOR = '#CBD5E1';

const formatUnknownStatus = (status: string): string =>
  status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');

/**
 * Merges raw task statuses into the display groups used across the dashboard
 * and drops empty groups, so only states that actually exist are rendered.
 * Result is sorted largest share first.
 */
export function buildStatusBreakdown(distribution: StatusDistribution[]): StatusBreakdownEntry[] {
  const totals = new Map<string, StatusBreakdownEntry>();

  for (const item of distribution) {
    const count = Number(item.count) || 0;
    if (count <= 0) continue;
    const group = STATUS_GROUPS[item.status] ?? { key: item.status, name: formatUnknownStatus(item.status), color: FALLBACK_COLOR };
    const existing = totals.get(group.key);
    if (existing) {
      existing.value += count;
    } else {
      totals.set(group.key, { key: group.key, name: group.name, value: count, percent: 0, color: group.color });
    }
  }

  const entries = [...totals.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  for (const entry of entries) {
    entry.percent = total > 0 ? (entry.value / total) * 100 : 0;
  }
  return entries;
}

export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return '<0.1%';
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}
