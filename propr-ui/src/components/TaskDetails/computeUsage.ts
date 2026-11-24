import type { ComputeUsage, HistoryItem } from './types';

const KIB = 1024;

/** `1.2 GiB`, `640 MiB`. */
export function formatMemory(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** `4m 12s`, `38s`, `1h 2m`. */
export function formatWallTime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const formatComputeCost = (cost: number): string => (cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);

export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The run's compute usage: the newest history entry that recorded one. */
export function pickComputeUsage(history: HistoryItem[] | null | undefined): ComputeUsage | undefined {
  if (!history) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const usage = history[index]?.metadata?.computeUsage;
    if (usage && typeof usage.runtime === 'string' && isFiniteNumber(usage.wallTimeMs)) return usage;
  }
  return undefined;
}

