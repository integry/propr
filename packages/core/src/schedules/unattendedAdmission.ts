import { getConfig, saveConfig } from '../config/configStore.js';
import { isValidTimeZone, wallClock } from './cron.js';

/**
 * Admission policy for unattended work: scheduled runs today, and any later
 * automatic run that nobody is watching. Manual runs never pass through here.
 */
export const DEFAULT_UNATTENDED_MAX_CONCURRENT = 1;
export const MAX_UNATTENDED_MAX_CONCURRENT = 100;

export interface UnattendedWindow {
  /** Minutes after local midnight, inclusive. */
  startMinute: number;
  /** Minutes after local midnight, exclusive; may be below `startMinute` for an overnight window. */
  endMinute: number;
  timeZone: string;
}

export type UnattendedWindowParse =
  | { ok: true; window: UnattendedWindow | null }
  | { ok: false; error: string };

const WINDOW_PATTERN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*@\s*(\S+)$/;

/**
 * Parses `HH:MM-HH:MM@Area/City`, for example `02:00-07:00@Europe/Riga`. An end
 * before the start spans midnight; `24:00` is accepted as an end. An empty value
 * means no window, so unattended work may start at any time.
 */
export function parseUnattendedWindow(value: unknown): UnattendedWindowParse {
  if (value === undefined || value === null) return { ok: true, window: null };
  if (typeof value !== 'string') return { ok: false, error: 'The unattended window must be text such as 02:00-07:00@Europe/Riga' };
  const text = value.trim();
  if (!text) return { ok: true, window: null };
  const match = WINDOW_PATTERN.exec(text);
  if (!match) return { ok: false, error: `"${text}" is not a window such as 02:00-07:00@Europe/Riga` };
  const [, startHour, startMinute, endHour, endMinute, timeZone] = match;
  const start = Number(startHour) * 60 + Number(startMinute);
  const end = Number(endHour) * 60 + Number(endMinute);
  if (Number(startMinute) > 59 || Number(endMinute) > 59 || start >= 24 * 60 || end > 24 * 60) {
    return { ok: false, error: `"${text}" contains a time that is not on a 24-hour clock` };
  }
  if (start === end) return { ok: false, error: `"${text}" starts and ends at the same time` };
  if (!isValidTimeZone(timeZone)) return { ok: false, error: `"${timeZone}" is not an IANA time zone` };
  return { ok: true, window: { startMinute: start, endMinute: end, timeZone } };
}

export function isInsideUnattendedWindow(window: UnattendedWindow, now: Date): boolean {
  const wall = wallClock(now.getTime(), window.timeZone);
  const minute = wall.hour * 60 + wall.minute;
  return window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute;
}

export interface UnattendedAdmissionSettings {
  maxConcurrent: number;
  /** The stored text, kept so Settings can show what an operator typed. */
  window: string;
  /** Present when the stored window is malformed; unattended work is then blocked. */
  windowError: string | null;
}

export type UnattendedAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'concurrency' | 'outside_window' | 'malformed_window'; message: string };

export function decideUnattendedAdmission(settings: UnattendedAdmissionSettings, running: number, now: Date): UnattendedAdmission {
  const parsed = parseUnattendedWindow(settings.window);
  if (!parsed.ok) {
    // Fail closed: a typo must never widen when unattended work may start.
    return { admitted: false, reason: 'malformed_window', message: `Unattended work is blocked because the unattended window is malformed: ${parsed.error}` };
  }
  if (parsed.window && !isInsideUnattendedWindow(parsed.window, now)) {
    return { admitted: false, reason: 'outside_window', message: `Outside the unattended window ${settings.window.trim()}` };
  }
  if (running >= settings.maxConcurrent) {
    return { admitted: false, reason: 'concurrency', message: `${running} unattended task${running === 1 ? ' is' : 's are'} already running (limit ${settings.maxConcurrent})` };
  }
  return { admitted: true };
}

export function parseUnattendedMaxConcurrent(value: unknown): number | null {
  const candidate = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= MAX_UNATTENDED_MAX_CONCURRENT
    ? candidate
    : null;
}

export async function loadUnattendedMaxConcurrent(): Promise<number> {
  return parseUnattendedMaxConcurrent(await getConfig<unknown>('unattended_max_concurrent', DEFAULT_UNATTENDED_MAX_CONCURRENT))
    ?? DEFAULT_UNATTENDED_MAX_CONCURRENT;
}

export async function saveUnattendedMaxConcurrent(value: number): Promise<void> {
  if (parseUnattendedMaxConcurrent(value) === null) {
    throw new Error(`unattended_max_concurrent must be an integer from 0 to ${MAX_UNATTENDED_MAX_CONCURRENT}`);
  }
  await saveConfig('unattended_max_concurrent', value);
}

export async function loadUnattendedWindow(): Promise<string> {
  const stored = await getConfig<unknown>('unattended_window', '');
  // A non-text value is kept as text so it is reported as malformed, never ignored.
  return typeof stored === 'string' ? stored : JSON.stringify(stored);
}

/** Saving validates; a malformed value can only exist from an out-of-band write. */
export async function saveUnattendedWindow(value: string): Promise<void> {
  const parsed = parseUnattendedWindow(value);
  if (!parsed.ok) throw new Error(`unattended_window: ${parsed.error}`);
  await saveConfig('unattended_window', value.trim());
}

export async function loadUnattendedAdmissionSettings(): Promise<UnattendedAdmissionSettings> {
  const [maxConcurrent, window] = await Promise.all([loadUnattendedMaxConcurrent(), loadUnattendedWindow()]);
  const parsed = parseUnattendedWindow(window);
  return { maxConcurrent, window, windowError: parsed.ok ? null : parsed.error };
}
