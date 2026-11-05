/**
 * Shared arithmetic for the dashboard's historical stats section.
 *
 * The counts themselves come from `analyticsAggregates.ts`, the aggregation
 * the Analytics page reads, so the widget and the page never disagree.
 */

/**
 * Success rate over finished work only, as a percentage with one decimal.
 * Returns null when nothing finished: an unknown rate is never 0.
 */
export function successRate(completed: number, failed: number): number | null {
  const finished = completed + failed;
  if (finished <= 0) return null;
  return Number(((completed / finished) * 100).toFixed(1));
}
