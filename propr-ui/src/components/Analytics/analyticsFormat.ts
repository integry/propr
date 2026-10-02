/** Number formats shared by the Analytics metric strip and tables. */

/** `4,200,000` → `4.2M`: token counts are read for their order of magnitude. */
export const formatCompactNumber = (value: number): string =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

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
