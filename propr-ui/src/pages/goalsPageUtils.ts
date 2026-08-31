import type { GoalState } from '../api/goalsApi';

export const DEFAULT_GOALS_PAGE_SIZE = 50;

export const GOAL_STATE_OPTIONS: Array<{ value: GoalState | 'all'; label: string }> = [
  { value: 'all', label: 'All states' },
  { value: 'queued', label: 'Queued' },
  { value: 'planning', label: 'Planning' },
  { value: 'running', label: 'Running' },
  { value: 'pausing', label: 'Pausing' },
  { value: 'paused', label: 'Paused' },
  { value: 'recovering', label: 'Recovering' },
  { value: 'completing', label: 'Completing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export const GOAL_STATE_COLORS: Record<GoalState, string> = {
  queued: 'bg-slate-100 text-slate-700',
  planning: 'bg-violet-100 text-violet-800',
  running: 'bg-green-100 text-green-800',
  pausing: 'bg-amber-100 text-amber-800',
  paused: 'bg-gray-100 text-gray-700',
  recovering: 'bg-blue-100 text-blue-800',
  completing: 'bg-cyan-100 text-cyan-800',
  completed: 'bg-teal-100 text-teal-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-500',
};

export const GOAL_STATE_LABELS: Record<GoalState, string> = {
  queued: 'Queued',
  planning: 'Planning',
  running: 'Running',
  pausing: 'Pausing',
  paused: 'Paused',
  recovering: 'Recovering',
  completing: 'Completing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

export const formatTokens = (total: number): string => {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return String(total);
};
