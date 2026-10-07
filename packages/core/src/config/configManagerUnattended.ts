import {
  DEFAULT_UNATTENDED_MAX_CONCURRENT,
  isUnattendedMaxConcurrent,
  parseUnattendedWindow,
  UNATTENDED_MAX_CONCURRENT_SETTING,
  UNATTENDED_WINDOW_SETTING,
  type UnattendedWindow,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig } from './configStore.js';

type ReadConfig = <T>(key: string, fallback: T) => Promise<T>;

/**
 * The instance's cap on active unattended agent runs. A missing or malformed
 * stored value, or a failed read, uses the default.
 */
export async function loadUnattendedMaxConcurrent(
  { readConfig = getConfig }: { readConfig?: ReadConfig } = {},
): Promise<number> {
  try {
    const stored = await readConfig<unknown>(UNATTENDED_MAX_CONCURRENT_SETTING, DEFAULT_UNATTENDED_MAX_CONCURRENT);
    if (isUnattendedMaxConcurrent(stored)) return stored;
    logger.warn({ stored_value: stored }, `Invalid ${UNATTENDED_MAX_CONCURRENT_SETTING} in DB, using default`);
  } catch (error) {
    logger.warn({ err: error }, `Could not load ${UNATTENDED_MAX_CONCURRENT_SETTING}, using default`);
  }
  return DEFAULT_UNATTENDED_MAX_CONCURRENT;
}

export type UnattendedWindowSetting =
  | { configured: false }
  | { configured: true; value: string; window: UnattendedWindow }
  /** Stored but unusable: unattended runs are blocked until it is fixed. */
  | { configured: true; value: string; error: string };

/** Interprets a stored `unattended_window`; null or an empty string means no window. */
export function interpretUnattendedWindow(stored: unknown): UnattendedWindowSetting {
  if (stored === null || stored === undefined || (typeof stored === 'string' && stored.trim() === '')) return { configured: false };
  if (typeof stored !== 'string') return { configured: true, value: String(stored), error: 'the stored value is not text' };
  const parsed = parseUnattendedWindow(stored);
  return parsed.ok
    ? { configured: true, value: stored.trim(), window: parsed.window }
    : { configured: true, value: stored.trim(), error: parsed.error };
}

/**
 * The instance's local-time window for unattended agent runs. A malformed
 * value is returned with its error rather than ignored: the gate then blocks
 * unattended runs instead of allowing them at any hour.
 */
export async function loadUnattendedWindow(
  { readConfig = getConfig }: { readConfig?: ReadConfig } = {},
): Promise<UnattendedWindowSetting> {
  return interpretUnattendedWindow(await readConfig<unknown>(UNATTENDED_WINDOW_SETTING, null));
}
