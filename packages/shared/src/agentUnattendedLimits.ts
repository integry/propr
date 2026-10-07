/**
 * Admission limits for unattended agent runs (triggers other than `manual`),
 * shared by the cost gate, the settings API, the CLI and the Settings UI:
 *
 * - `unattended_max_concurrent`: how many unattended runs may be active
 *   (`queued`, `running` or `acting`) at once;
 * - `unattended_window`: an optional local-time window such as
 *   `02:00-07:00@Europe/Riga` outside of which unattended runs wait.
 */

export const UNATTENDED_MAX_CONCURRENT_SETTING = 'unattended_max_concurrent';
export const UNATTENDED_MAX_CONCURRENT_MIN = 1;
export const UNATTENDED_MAX_CONCURRENT_MAX = 100;
export const DEFAULT_UNATTENDED_MAX_CONCURRENT = 1;

export const UNATTENDED_WINDOW_SETTING = 'unattended_window';
export const UNATTENDED_WINDOW_MAX_LENGTH = 100;
export const UNATTENDED_WINDOW_EXAMPLE = '02:00-07:00@Europe/Riga';

export function isUnattendedMaxConcurrent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= UNATTENDED_MAX_CONCURRENT_MIN && value <= UNATTENDED_MAX_CONCURRENT_MAX;
}

export interface UnattendedWindow {
  /** Minutes after local midnight the window opens. */
  start: number;
  /** Minutes after local midnight the window closes (1440 for 24:00); before `start` for an overnight window. */
  end: number;
  /** IANA time zone the times are in. */
  timeZone: string;
}

export type UnattendedWindowParseResult =
  | { ok: true; window: UnattendedWindow }
  | { ok: false; error: string };

const WINDOW_PATTERN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?:\s*@\s*(\S+))?$/;
const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60_000;

function minutesOf(hours: string, minutes: string, allowEndOfDay: boolean): number | null {
  const h = Number(hours);
  const m = Number(minutes);
  if (m > 59) return null;
  if (h === 24 && m === 0 && allowEndOfDay) return MINUTES_PER_DAY;
  return h <= 23 ? h * 60 + m : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function isTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses `HH:MM-HH:MM@Time/Zone`. The zone defaults to UTC; an end before the
 * start is an overnight window (`22:00-06:00`), and `24:00` may end one.
 */
export function parseUnattendedWindow(value: string): UnattendedWindowParseResult {
  const text = value.trim();
  const match = text.length <= UNATTENDED_WINDOW_MAX_LENGTH ? WINDOW_PATTERN.exec(text) : null;
  if (!match) return { ok: false, error: `use the form HH:MM-HH:MM@Time/Zone, e.g. ${UNATTENDED_WINDOW_EXAMPLE}` };
  const start = minutesOf(match[1], match[2], false);
  const end = minutesOf(match[3], match[4], true);
  if (start === null || end === null) return { ok: false, error: 'times must be between 00:00 and 24:00' };
  if (start === end % MINUTES_PER_DAY) return { ok: false, error: 'the window must start and end at different times' };
  const timeZone = match[5] ?? 'UTC';
  if (!isTimeZone(timeZone)) return { ok: false, error: `unknown time zone "${timeZone}"` };
  return { ok: true, window: { start, end, timeZone } };
}

/** Minutes after local midnight in `timeZone` at `timestamp`. */
function localMinuteOfDay(timestamp: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(timestamp));
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0) % 24;
  return hour * 60 + Number(parts.find(part => part.type === 'minute')?.value ?? 0);
}

function containsMinute({ start, end }: UnattendedWindow, minute: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function isInsideUnattendedWindow(window: UnattendedWindow, timestamp: number): boolean {
  return containsMinute(window, localMinuteOfDay(timestamp, window.timeZone));
}

/** Longest search for the next opening or closing; covers a window skipped by a DST gap. */
const SEARCH_LIMIT_MINUTES = 3 * MINUTES_PER_DAY;

/**
 * The first whole minute after `timestamp` where the window is open (or
 * closed, with `open` false). Walking real minutes and reading the local
 * clock handles DST: a start time skipped by a spring-forward gap opens the
 * window at the first local minute after the gap, and a repeated hour in the
 * autumn opens it at the first occurrence.
 */
function nextMinuteWhere(window: UnattendedWindow, timestamp: number, open: boolean): number | null {
  const first = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < SEARCH_LIMIT_MINUTES; step += 1) {
    const candidate = first + step * MINUTE_MS;
    if (isInsideUnattendedWindow(window, candidate) === open) return candidate;
  }
  return null;
}

export interface UnattendedWindowState {
  open: boolean;
  /** When a closed window next opens. */
  opensAt?: number;
  /** When an open window next closes. */
  closesAt?: number;
}

export function unattendedWindowState(window: UnattendedWindow, timestamp: number): UnattendedWindowState {
  const open = isInsideUnattendedWindow(window, timestamp);
  const boundary = nextMinuteWhere(window, timestamp, !open);
  if (boundary === null) return { open };
  return open ? { open, closesAt: boundary } : { open, opensAt: boundary };
}

/** `HH:MM` local time of `timestamp` in `timeZone`. */
export function formatUnattendedWindowTime(timestamp: number, timeZone: string): string {
  const minute = localMinuteOfDay(timestamp, timeZone);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** `02:00-07:00 Europe/Riga`, the window as people read it. */
export function describeUnattendedWindow({ start, end, timeZone }: UnattendedWindow): string {
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return `${clock(start)}-${clock(end)} ${timeZone}`;
}
