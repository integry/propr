/**
 * The one place the UI turns a timestamp or a count into text.
 *
 * - Recent moments (the last 7 days, either side of now) read as a compact
 *   relative age: `just now`, `5m ago`, `2h ago`, `3d ago`, `in 2h`.
 * - Anything older (or further ahead) reads as a calendar date: `Nov 2, 2026`.
 * - The full local date and time (`Nov 2, 2026, 10:12:47 AM`) belongs in the
 *   tooltip, via {@link formatDateTime} or the `<RelativeTime>` component.
 *
 * Call sites must not use `toLocaleString()` / `toLocaleDateString()` /
 * `toLocaleTimeString()` on dates directly: `dateFormat.guard.test.ts` fails
 * when one appears outside this file.
 */

export type DateInput = string | number | Date | null | undefined;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How far from now a timestamp stays relative before it becomes a date. */
const RELATIVE_WINDOW_DAYS = 7;

/** A valid `Date` for the input, or `null` when it is missing or unparseable. */
export function parseDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const dateFormatter = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options);

/** `Nov 2, 2026`. Empty for a missing or unparseable timestamp. */
export function formatDate(value: DateInput, options: { timeZone?: string } = {}): string {
  const date = parseDate(value);
  return date ? dateFormatter({ month: 'short', day: 'numeric', year: 'numeric', ...options }).format(date) : '';
}

/** `Nov 2` — a day without its year, for chart axes and dense day lists. */
export function formatShortDate(value: DateInput, options: { timeZone?: string } = {}): string {
  const date = parseDate(value);
  return date ? dateFormatter({ month: 'short', day: 'numeric', ...options }).format(date) : '';
}

/** `Nov` — a month alone, for chart axes that label the month once. */
export function formatMonth(value: DateInput, options: { timeZone?: string } = {}): string {
  const date = parseDate(value);
  return date ? dateFormatter({ month: 'short', ...options }).format(date) : '';
}

/** `Tue` — a weekday alone, for chart axes across a week or two. */
export function formatWeekday(value: DateInput, options: { timeZone?: string } = {}): string {
  const date = parseDate(value);
  return date ? dateFormatter({ weekday: 'short', ...options }).format(date) : '';
}

/** `Nov 2, 2026, 10:12:47 AM` — the full local date and time, for tooltips and audit detail. */
export function formatDateTime(value: DateInput): string {
  const date = parseDate(value);
  return date
    ? dateFormatter({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date)
    : '';
}

/** `10:12 AM` — a time of day, for message bubbles and chart ticks within one day. */
export function formatTimeOfDay(value: DateInput): string {
  const date = parseDate(value);
  return date ? dateFormatter({ hour: 'numeric', minute: '2-digit' }).format(date) : '';
}

/** `10:12:47` — a 24-hour clock stamp for log lines, where every second is a separate event. */
export function formatClockTime(value: DateInput): string {
  const date = parseDate(value);
  return date ? dateFormatter({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date) : '';
}

/** `Tue 10 AM` — a weekday and hour, for chart ticks across a few days. */
export function formatWeekdayHour(value: DateInput): string {
  const date = parseDate(value);
  return date ? dateFormatter({ weekday: 'short', hour: 'numeric' }).format(date) : '';
}

/** `Nov 2, 10:12 AM` — a date and minute without the year, for chart tooltips. */
export function formatShortDateTime(value: DateInput): string {
  const date = parseDate(value);
  return date ? dateFormatter({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date) : '';
}

/**
 * `just now`, `5m ago`, `2h ago`, `3d ago` for the last 7 days (`in 5m`, `in 2h`, `in 3d` ahead of
 * now), then `Nov 2, 2026`. Empty for a missing or unparseable timestamp.
 */
export function formatRelativeTime(value: DateInput, now: number = Date.now()): string {
  const date = parseDate(value);
  if (!date) return '';
  const diff = now - date.getTime();
  const abs = Math.abs(diff);
  if (abs >= RELATIVE_WINDOW_DAYS * DAY) return formatDate(date);
  if (abs < MINUTE) return 'just now';
  const amount = abs < HOUR ? `${Math.floor(abs / MINUTE)}m` : abs < DAY ? `${Math.floor(abs / HOUR)}h` : `${Math.floor(abs / DAY)}d`;
  return diff >= 0 ? `${amount} ago` : `in ${amount}`;
}

/** The ISO string for a `<time dateTime>` attribute, or `undefined` when the input is not a date. */
export function toDateTimeAttribute(value: DateInput): string | undefined {
  return parseDate(value)?.toISOString();
}

/** A count with the locale's thousands separator: `165,297`. Non-finite values render as `—`. */
export function formatCount(value: number | null | undefined, options?: Intl.NumberFormatOptions): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, options) : '—';
}

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w:])/g;

/**
 * Free text (a preview caption written by the server) with every ISO-8601 timestamp in it shown as
 * `Nov 2, 2026`, so a stored `2027-01-31T10:11:29.284Z` never reaches the screen raw.
 */
export function formatTimestampsInText(text: string): string {
  return text.replace(ISO_TIMESTAMP, match => formatDate(match) || match);
}
