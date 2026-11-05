import { loadAgentTankSettings } from '../config/configManager.js';
import logger from '../utils/logger.js';
import { getStatusForAlias, type AgentStatusResponse } from './agentTankService.js';
import type { SyntheticUsageSnapshot, SyntheticUsageSnapshotProvider } from './syntheticRoutingTypes.js';

const DEFAULT_USAGE_FRESHNESS_MS = 5 * 60_000;

function finitePercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function nestedPercent(usage: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = usage[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const percent = finitePercent((value as Record<string, unknown>).percent)
        ?? finitePercent((value as Record<string, unknown>).percentUsed);
      if (percent !== undefined) return percent;
    }
  }
  return undefined;
}

function sessionResetsAt(usage: Record<string, unknown>, capturedAt: Date): Date | undefined {
  const session = usage.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) return undefined;
  const seconds = (session as Record<string, unknown>).resetsInSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? new Date(capturedAt.getTime() + seconds * 1000)
    : undefined;
}

/**
 * Provides fresh usage data only when Agent Tank names the requested direct alias
 * exactly. `getStatusForAlias` is what makes that name trustworthy in bundled
 * mode, where only one account per provider is inspected: it refuses to answer
 * for an alias whose credentials did not produce the snapshot, and names the
 * answers it does give after the alias that produced them rather than after the
 * provider key the bundled snapshot carries.
 */
export class AliasSpecificAgentTankSnapshotProvider implements SyntheticUsageSnapshotProvider {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly freshnessMs = Number(process.env.SYNTHETIC_USAGE_FRESHNESS_MS) || DEFAULT_USAGE_FRESHNESS_MS,
    private readonly fetchStatus: (alias: string) => Promise<AgentStatusResponse> = getStatusForAlias,
  ) {}

  async getSnapshot(directAgentAlias: string): Promise<SyntheticUsageSnapshot | null> {
    const settings = await loadAgentTankSettings();
    if (!settings.enabled) return null;

    let status: AgentStatusResponse;
    try {
      status = await this.fetchStatus(directAgentAlias);
    } catch (error) {
      logger.warn({ directAgentAlias, error: (error as Error).message }, 'Alias-specific usage snapshot unavailable');
      return null;
    }

    if (status.name !== directAgentAlias || status.error || status.isRefreshing || !status.lastUpdated) return null;
    const capturedAt = new Date(status.lastUpdated);
    if (!Number.isFinite(capturedAt.getTime()) || this.now().getTime() - capturedAt.getTime() > this.freshnessMs) return null;

    return {
      directAgentAlias,
      capturedAt,
      sessionPercent: nestedPercent(status.usage, ['session']),
      weeklyPercent: nestedPercent(status.usage, ['weekly', 'weeklyAll', 'week']),
      sessionResetsAt: sessionResetsAt(status.usage, capturedAt),
    };
  }
}
