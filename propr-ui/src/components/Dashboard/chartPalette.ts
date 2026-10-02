/**
 * Colour rule for the daily charts on the dashboard and Analytics.
 *
 * History is quiet. A day that has already closed cannot be acted on, so it
 * gets no marker at all, however many completions it holds, and a bar for it
 * is neutral slate; only the day still accumulating is marked, in brand teal.
 * This lives apart from the chart components so the rule can be read and
 * tested on its own.
 */

/** The day still accumulating. */
export const CURRENT_DAY_FILL = '#14B8A6';

/** A day that has closed, where it has to be drawn at all (slate-300). */
export const SETTLED_DAY_FILL = '#CBD5E1';

/** The buckets are UTC days, so "today" has to be read in UTC too. */
export const utcToday = (): string => new Date().toISOString().slice(0, 10);

/** The marker colour for a day, or null for a settled day that carries none. */
export const dailyPointFill = (date: string, today: string): string | null =>
  date === today ? CURRENT_DAY_FILL : null;

/** The bar colour for a day: teal while it accumulates, slate once it has closed. */
export const dailyBarFill = (date: string, today: string): string =>
  dailyPointFill(date, today) ?? SETTLED_DAY_FILL;
