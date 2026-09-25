/**
 * Colour rule for the dashboard's historical chart.
 *
 * History is unmarked. A day that has already closed cannot be acted on, so it
 * gets no marker at all, however many completions it holds; only the day
 * still accumulating is marked, in brand teal. This lives apart from the chart
 * component so the rule can be read and tested on its own.
 */

/** The day still accumulating. */
export const CURRENT_DAY_FILL = '#14B8A6';

/** The buckets are UTC days, so "today" has to be read in UTC too. */
export const utcToday = (): string => new Date().toISOString().slice(0, 10);

/** The marker colour for a day, or null for a settled day that carries none. */
export const dailyPointFill = (date: string, today: string): string | null =>
  date === today ? CURRENT_DAY_FILL : null;
