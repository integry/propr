/**
 * Colour rule for the dashboard's historical chart.
 *
 * History is neutral. A day that has already closed cannot be acted on, so its
 * marker is drawn in slate however many completions it holds; only the day
 * still accumulating takes brand teal. This lives apart from the chart
 * component so the rule can be read and tested on its own.
 */

/** Settled history. */
export const PAST_DAY_FILL = '#CBD5E1';
/** The day still accumulating. */
export const CURRENT_DAY_FILL = '#14B8A6';

/** The buckets are UTC days, so "today" has to be read in UTC too. */
export const utcToday = (): string => new Date().toISOString().slice(0, 10);

export const dailyPointFill = (date: string, today: string): string =>
  date === today ? CURRENT_DAY_FILL : PAST_DAY_FILL;
