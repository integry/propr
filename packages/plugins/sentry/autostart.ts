import type { PluginContext, PluginJsonValue } from '@propr/shared';
import type { AutoStartSettings } from './settings.js';

/**
 * Whether a created issue gets the trigger label, so ProPR starts a task at
 * once. Off unless "Start a task automatically" is on; then the Sentry issue
 * must have at least the minimum event count, its latest event an allowed
 * environment, and the repository a start left in today's cap.
 *
 * The cap is counted in `ctx.state`, one key per repository
 * (`autostart:<owner/repo>`) holding the UTC date and the starts made that
 * day: a new day starts from zero. Taking a start is one atomic
 * `ctx.state.update`, so an alert storm delivered in parallel cannot start
 * more than the cap.
 */

export type NotStartedReason = 'setting_off' | 'event_count' | 'environment' | 'daily_cap';
export type StartDecision = { start: true; slot: { key: string; date: string } } | { start: false; reason: NotStartedReason };

/** The UTC date of a time, `2026-11-17`. */
export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const capKey = (repository: string): string => `autostart:${repository.toLowerCase()}`;

interface CapRecord { d: string; n: number }
const capRecord = (value: PluginJsonValue | undefined): CapRecord | null => {
  const record = value as Partial<CapRecord> | undefined;
  return record && typeof record === 'object' && typeof record.d === 'string' && typeof record.n === 'number' ? { d: record.d, n: record.n } : null;
};

/** The automatic starts used for `repository` on `date`. */
export async function startsUsed(ctx: PluginContext, repository: string, date: string): Promise<number> {
  const record = capRecord(await ctx.state.get(capKey(repository)));
  return record?.d === date ? record.n : 0;
}

/** Take one start of today's cap: true when one was left. */
async function takeStart(ctx: PluginContext, key: string, date: string, cap: number): Promise<boolean> {
  let taken = false;
  await ctx.state.update(key, current => {
    const record = capRecord(current);
    const used = record?.d === date ? record.n : 0;
    if (used >= cap) return undefined;
    taken = true;
    return { d: date, n: used + 1 };
  });
  return taken;
}

/** Give a start back: its issue was not created. */
export async function releaseStart(ctx: PluginContext, slot: { key: string; date: string }): Promise<void> {
  await ctx.state.update(slot.key, current => {
    const record = capRecord(current);
    return record && record.d === slot.date && record.n > 0 ? { d: record.d, n: record.n - 1 } : undefined;
  });
}

/**
 * Decide whether to start: the guards in order (setting, event count,
 * environment), then the cap, which is taken only when the others pass.
 */
export async function decideStart(ctx: PluginContext, settings: AutoStartSettings, error: { repository: string; count: number | null; environment: string | null; receivedAt: number }): Promise<StartDecision> {
  if (!settings.enabled) return { start: false, reason: 'setting_off' };
  if (error.count === null || error.count < settings.minEventCount) return { start: false, reason: 'event_count' };
  if (settings.environments.length && (!error.environment || !settings.environments.includes(error.environment.toLowerCase()))) return { start: false, reason: 'environment' };
  const slot = { key: capKey(error.repository), date: utcDate(error.receivedAt) };
  return await takeStart(ctx, slot.key, slot.date, settings.dailyCap) ? { start: true, slot } : { start: false, reason: 'daily_cap' };
}

/** The issue body's sentence about starting work, from the decision and the settings only. */
export function startSentence(decision: StartDecision, settings: AutoStartSettings, label: string): string {
  const add = `Add the \`${label.replace(/`/g, '')}\` label to start a ProPR task.`;
  if (decision.start) return 'ProPR started a task for this error automatically.';
  switch (decision.reason) {
    case 'setting_off': return `Not started automatically: the plugin leaves that to a person. ${add}`;
    case 'event_count': return `Not started automatically: the Sentry issue had fewer than ${settings.minEventCount} events when it was reported. ${add}`;
    case 'environment': return `Not started automatically: the latest event's environment is not one of ${settings.environments.map(e => `\`${e.replace(/`/g, '')}\``).join(', ')}. ${add}`;
    case 'daily_cap': return `Not started automatically: the daily cap of ${settings.dailyCap} automatically started task${settings.dailyCap === 1 ? '' : 's'} for this repository was reached (UTC day). ${add}`;
  }
}
