/** Number formats shared by the Analytics metric strip and tables. */

/** `4,200,000` → `4.2M`: token counts are read for their order of magnitude. */
export const formatCompactNumber = (value: number): string =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

/** A share from 0–1 as a whole percentage: `0.884` → `88%`. */
export const formatShare = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Wall-clock minutes at the precision a cycle time is read at:
 * `14m 20s`, `3h 12m`, `2d 4h`.
 */
export const formatDuration = (minutes: number): string => {
  const seconds = Math.max(0, Math.round(minutes * 60));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 24 * 60) return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  const totalHours = Math.round(totalMinutes / 60);
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
};

/** Dollars to the cent, with thousands separators. */
export const formatUsd = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Share of finished tasks that succeeded, to one decimal, or null when
 * nothing finished: a period with no outcomes has no success rate, not 0%.
 */
export const successRate = (completed: number, failed: number): number | null => {
  const finished = completed + failed;
  return finished > 0 ? Math.round((completed / finished) * 1000) / 10 : null;
};
