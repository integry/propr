import type { Knex } from 'knex';
import {
  describeUnattendedWindow,
  formatUnattendedWindowTime,
  unattendedWindowState,
} from '@propr/shared';
import { getConfig, getConfigWithClient } from '../../config/configStore.js';
import {
  loadUnattendedMaxConcurrent,
  loadUnattendedWindow,
  type UnattendedWindowSetting,
} from '../../config/configManagerUnattended.js';
import { countActiveUnattendedAgentRuns } from './agentRunStore.js';
import type { AgentRunGateDecision } from './agentRunTrigger.js';

/**
 * Admission limits the cost gate applies to unattended runs after the usage
 * checks, when a run is created or a deferred run is retried:
 *
 * - a malformed `unattended_window` skips the run: unattended work stays
 *   blocked (and Settings shows a warning) until the window is fixed, rather
 *   than running at any hour;
 * - outside the window the run is deferred until the window opens; that wait
 *   does not count against the deferral limit;
 * - with `unattended_max_concurrent` unattended runs already `queued`,
 *   `running` or `acting`, the run is deferred one short step, which counts
 *   against the deferral limit.
 */

/** Deferral while the unattended concurrency cap is reached; the run is re-evaluated after it. */
export const DEFAULT_AGENT_RUN_CAP_DEFER_STEP_MS = 5 * 60_000;
/** Retry delay when a closed window's next opening cannot be computed. */
const WINDOW_FALLBACK_DEFER_MS = 60 * 60_000;

export function formatAgentRunUtc(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export type UnattendedWindowStatus =
  | { configured: false }
  | {
    configured: true;
    value: string;
    /** `02:00-07:00 Europe/Riga`. */
    description: string;
    timeZone: string;
    open: boolean;
    opensAt?: number;
    /** Local `HH:MM` of `opensAt` in the window's time zone. */
    opensAtLocal?: string;
    closesAt?: number;
    closesAtLocal?: string;
  }
  | { configured: true; value: string; error: string };

export interface UnattendedLimitsStatus {
  concurrency: { active: number; cap: number; reached: boolean };
  window: UnattendedWindowStatus;
}

export interface UnattendedLimitsDependencies {
  now?: () => number;
  /** Database the settings are read from and active runs counted in; defaults to the shared connection. */
  database?: Knex;
  loadMaxConcurrent?: () => Promise<number>;
  loadWindow?: () => Promise<UnattendedWindowSetting>;
  countActiveUnattendedRuns?: () => Promise<number>;
}

export function unattendedWindowStatus(setting: UnattendedWindowSetting, timestamp: number): UnattendedWindowStatus {
  if (!setting.configured) return { configured: false };
  if ('error' in setting) return { configured: true, value: setting.value, error: setting.error };
  const { window } = setting;
  const state = unattendedWindowState(window, timestamp);
  return {
    configured: true,
    value: setting.value,
    description: describeUnattendedWindow(window),
    timeZone: window.timeZone,
    open: state.open,
    ...(state.opensAt !== undefined ? { opensAt: state.opensAt, opensAtLocal: formatUnattendedWindowTime(state.opensAt, window.timeZone) } : {}),
    ...(state.closesAt !== undefined ? { closesAt: state.closesAt, closesAtLocal: formatUnattendedWindowTime(state.closesAt, window.timeZone) } : {}),
  };
}

/** Current cap usage and window state, for the gate and the capacity endpoint. */
export async function evaluateUnattendedLimits(deps: UnattendedLimitsDependencies = {}): Promise<UnattendedLimitsStatus> {
  const { now = Date.now, database } = deps;
  const readConfig = <T>(key: string, fallback: T): Promise<T> =>
    database ? getConfigWithClient(key, fallback, database) : getConfig(key, fallback);
  const {
    loadMaxConcurrent = () => loadUnattendedMaxConcurrent({ readConfig }),
    loadWindow = () => loadUnattendedWindow({ readConfig }),
    countActiveUnattendedRuns = () => countActiveUnattendedAgentRuns({ database }),
  } = deps;
  const [cap, setting, active] = await Promise.all([loadMaxConcurrent(), loadWindow(), countActiveUnattendedRuns()]);
  return {
    concurrency: { active, cap, reached: active >= cap },
    window: unattendedWindowStatus(setting, now()),
  };
}

function activeRuns(active: number): string {
  return active === 1 ? '1 unattended run is already active' : `${active} unattended runs are already active`;
}

/**
 * The gate decision for the admission limits. Every reason is a full
 * sentence: run history shows it verbatim.
 */
export function unattendedLimitsDecision(
  { concurrency, window }: UnattendedLimitsStatus,
  { now, deferrals, maxDeferrals, capDeferStepMs }: { now: number; deferrals: number; maxDeferrals: number; capDeferStepMs: number },
): AgentRunGateDecision {
  if (window.configured && 'error' in window) {
    return {
      action: 'skip',
      reason: `The unattended window setting "${window.value}" is malformed (${window.error}), so unattended runs are blocked until it is fixed in Settings.`,
    };
  }
  if (window.configured && !window.open) {
    const until = window.opensAt ?? now + WINDOW_FALLBACK_DEFER_MS;
    const opens = window.opensAtLocal ? `it opens at ${window.opensAtLocal} ${window.timeZone} (${formatAgentRunUtc(until)})` : formatAgentRunUtc(until);
    return {
      action: 'defer',
      until,
      countsDeferral: false,
      reason: `Outside the unattended window ${window.description}, so the run was deferred until ${opens}.`,
    };
  }
  if (concurrency.reached) {
    const busy = `${activeRuns(concurrency.active)} (cap ${concurrency.cap})`;
    if (deferrals >= maxDeferrals) {
      return { action: 'skip', reason: `${busy}, and the run was already deferred ${deferrals} times, so it was skipped.` };
    }
    const until = now + capDeferStepMs;
    return { action: 'defer', until, reason: `${busy}, so the run was deferred until ${formatAgentRunUtc(until)}.` };
  }
  return { action: 'proceed' };
}
