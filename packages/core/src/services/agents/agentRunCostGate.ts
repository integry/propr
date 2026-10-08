import type { Knex } from 'knex';
import type { SyntheticAgentConfig } from '@propr/shared';
import { getConfig } from '../../config/configManager.js';
import { loadAgents, type AgentConfig } from '../../config/configManagerAgents.js';
import { loadSyntheticAgents } from '../../config/configManagerSyntheticAgents.js';
import logger from '../../utils/logger.js';
import type { SyntheticUsageSnapshotProvider } from '../syntheticRoutingTypes.js';
import { AliasSpecificAgentTankSnapshotProvider } from '../syntheticUsageSnapshotProvider.js';
import type { StoredAgentRun } from './agentRunStore.js';
import { loadConfiguredDefaultAgentAlias, type AgentRunGate, type AgentRunGateDecision } from './agentRunTrigger.js';
import {
  DEFAULT_AGENT_RUN_CAP_DEFER_STEP_MS,
  evaluateUnattendedLimits,
  formatAgentRunUtc,
  unattendedLimitsDecision,
  type UnattendedLimitsDependencies,
} from './agentRunUnattendedLimits.js';

/**
 * Agent Tank usage gate for unattended agent runs.
 *
 * Scheduled and externally triggered runs (`schedule`, `api`, `mcp`, `cli`)
 * happen with nobody watching, so before one starts, before a deferred run is
 * retried and before an `auto` acting step starts, the provider's subscription
 * usage is compared with the instance's pause threshold
 * (`agent_run_usage_pause_percent`):
 *
 * - `manual` (UI "Run now") always proceeds; the UI shows the capacity warning.
 * - Unknown capacity (Agent Tank disabled, unreachable or without a fresh
 *   snapshot) proceeds, like `ultrafixEscalation`: a monitoring outage must
 *   never silently stop all automation.
 * - Weekly usage at or over the threshold skips the run: a weekly window does
 *   not recover within hours.
 * - Session usage at or over the threshold defers the run until shortly after
 *   the session window resets (at most `deferStepMs` at a time), and skips it
 *   after `maxDeferrals` deferrals.
 *
 * After the usage checks, a run being admitted (a new run or a deferred retry,
 * not an admitted run's `auto` acting step) must also pass the instance's
 * unattended admission limits (`agentRunUnattendedLimits.ts`): the local-time
 * window (`unattended_window`) and the cap on active unattended runs
 * (`unattended_max_concurrent`).
 *
 * The gate only reads the snapshot Agent Tank already holds; it never asks the
 * bundled Agent Tank to refresh (that may start a container). A stale snapshot
 * is acceptable: the gate is a brake, not an accounting system.
 *
 * Agents v1 performs no model escalation. Any future escalation path for agent
 * runs must call this gate before handing a run to another model.
 */

export const AGENT_RUN_USAGE_PAUSE_PERCENT_SETTING = 'agent_run_usage_pause_percent';
export const AGENT_RUN_USAGE_PAUSE_PERCENT_MIN = 50;
export const AGENT_RUN_USAGE_PAUSE_PERCENT_MAX = 100;
export const DEFAULT_AGENT_RUN_USAGE_PAUSE_PERCENT = 90;
export const DEFAULT_AGENT_RUN_MAX_DEFERRALS = 6;
export const DEFAULT_AGENT_RUN_DEFER_STEP_MS = 30 * 60_000;
/** Margin after the session window resets before a deferred run is retried. */
export const AGENT_RUN_DEFER_RESET_MARGIN_MS = 2 * 60_000;
/** How old a usage snapshot the gate still trusts; older ones count as unknown. */
export const AGENT_RUN_USAGE_SNAPSHOT_MAX_AGE_MS = 60 * 60_000;

export function isAgentRunUsagePausePercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= AGENT_RUN_USAGE_PAUSE_PERCENT_MIN && value <= AGENT_RUN_USAGE_PAUSE_PERCENT_MAX;
}

/**
 * The instance-wide "pause at % of subscription usage" threshold. A missing or
 * malformed stored value, or a failed read, uses the default.
 */
export async function loadUsagePauseThreshold(
  { readConfig = getConfig }: { readConfig?: <T>(key: string, fallback: T) => Promise<T> } = {},
): Promise<number> {
  try {
    const stored = await readConfig<unknown>(AGENT_RUN_USAGE_PAUSE_PERCENT_SETTING, DEFAULT_AGENT_RUN_USAGE_PAUSE_PERCENT);
    if (isAgentRunUsagePausePercent(stored)) return stored;
    logger.warn({ stored_value: stored }, `Invalid ${AGENT_RUN_USAGE_PAUSE_PERCENT_SETTING} in DB, using default`);
  } catch (error) {
    logger.warn({ err: error }, `Could not load ${AGENT_RUN_USAGE_PAUSE_PERCENT_SETTING}, using default`);
  }
  return DEFAULT_AGENT_RUN_USAGE_PAUSE_PERCENT;
}

export type ProviderCapacityStatus = 'ok' | 'near_limit' | 'unknown';

export interface ProviderCapacity {
  status: ProviderCapacityStatus;
  sessionPercent?: number;
  weeklyPercent?: number;
  /** Time until the session window resets, when Agent Tank reported it. */
  resetsInMs?: number;
  /** What the usage belongs to: the agent type (e.g. `claude`) or the synthetic pool alias. */
  provider: string;
}

export interface ProviderCapacityDependencies {
  /** Model of a synthetic pool to evaluate; defaults to the pool's default model. */
  modelName?: string | null;
  now?: () => number;
  snapshotProvider?: SyntheticUsageSnapshotProvider;
  loadAgents?: () => Promise<AgentConfig[]>;
  loadSyntheticAgents?: () => Promise<SyntheticAgentConfig[]>;
  loadDefaultAgentAlias?: () => Promise<string | null>;
}

function defaultSnapshotProvider(): SyntheticUsageSnapshotProvider {
  return new AliasSpecificAgentTankSnapshotProvider(() => new Date(), AGENT_RUN_USAGE_SNAPSHOT_MAX_AGE_MS);
}

function atOrOver(percent: number | undefined, threshold: number): boolean {
  return percent !== undefined && percent >= threshold;
}

async function evaluateDirectAgent(
  agent: AgentConfig,
  threshold: number,
  provider: SyntheticUsageSnapshotProvider,
  now: number,
): Promise<ProviderCapacity> {
  let snapshot;
  try {
    snapshot = await provider.getSnapshot(agent.alias);
  } catch (error) {
    logger.warn({ alias: agent.alias, err: error }, 'Agent Tank usage snapshot unavailable for the agent run cost gate');
    snapshot = null;
  }
  if (!snapshot || (snapshot.sessionPercent === undefined && snapshot.weeklyPercent === undefined)) {
    return { status: 'unknown', provider: agent.type };
  }
  const { sessionPercent, weeklyPercent, sessionResetsAt } = snapshot;
  const nearLimit = atOrOver(sessionPercent, threshold) || atOrOver(weeklyPercent, threshold);
  return {
    status: nearLimit ? 'near_limit' : 'ok',
    provider: agent.type,
    ...(sessionPercent !== undefined ? { sessionPercent } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(sessionResetsAt ? { resetsInMs: Math.max(0, sessionResetsAt.getTime() - now) } : {}),
  };
}

function minimum(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

/**
 * A pool is near its limit only when every member is. The pool is then
 * weekly-limited only if every member is weekly-limited (`weeklyPercent` is the
 * lowest member's); otherwise it recovers when the first session-limited
 * member resets, and every figure, including `weeklyPercent`, comes from the
 * session-limited members only, so the gate never mistakes it for a weekly
 * limit.
 */
function combinePoolCapacity(alias: string, members: ProviderCapacity[], threshold: number): ProviderCapacity {
  if (members.some(member => member.status === 'ok')) return { status: 'ok', provider: alias };
  if (members.length === 0 || members.some(member => member.status === 'unknown')) return { status: 'unknown', provider: alias };
  if (members.every(member => atOrOver(member.weeklyPercent, threshold))) {
    return { status: 'near_limit', provider: alias, weeklyPercent: minimum(members.map(member => member.weeklyPercent))! };
  }
  const sessionLimited = members.filter(member => !atOrOver(member.weeklyPercent, threshold));
  const weeklyPercent = minimum(sessionLimited.map(member => member.weeklyPercent));
  const sessionPercent = minimum(sessionLimited.map(member => member.sessionPercent));
  const resetsInMs = minimum(sessionLimited.map(member => member.resetsInMs));
  return {
    status: 'near_limit',
    provider: alias,
    ...(sessionPercent !== undefined ? { sessionPercent } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(resetsInMs !== undefined ? { resetsInMs } : {}),
  };
}

/** Enabled direct agents a synthetic pool's model can route to, without duplicates. */
function poolMembers(pool: SyntheticAgentConfig, modelName: string | null, agents: AgentConfig[]): AgentConfig[] {
  const models = pool.models.filter(model => model.enabled);
  const chosen = models.find(model => model.id === (modelName ?? pool.defaultModel));
  const members = (chosen ? [chosen] : models).flatMap(model => model.members.filter(member => member.enabled));
  const aliases = [...new Set(members.map(member => member.directAgentAlias))];
  return aliases.flatMap(alias => agents.filter(agent => agent.alias === alias && agent.enabled));
}

/** The direct agent the worker uses when a definition names none, like `AgentRegistry.getDefaultAgent`. */
function defaultDirectAgent(agents: AgentConfig[], configuredAlias: string | null): AgentConfig | undefined {
  const enabled = agents.filter(agent => agent.enabled);
  return (configuredAlias ? enabled.find(agent => agent.alias === configuredAlias) : undefined)
    ?? enabled.find(agent => agent.alias === 'default');
}

/**
 * Current subscription capacity for the agent a definition runs on, from the
 * cached Agent Tank snapshot. `agentAlias` null means the default agent. A
 * synthetic pool evaluates every enabled member and is `near_limit` only when
 * all of them are. Never throws: anything that cannot be evaluated is `unknown`.
 */
export async function evaluateProviderCapacity(
  agentAlias: string | null,
  threshold: number,
  deps: ProviderCapacityDependencies = {},
): Promise<ProviderCapacity> {
  const {
    modelName = null,
    now = Date.now,
    snapshotProvider = defaultSnapshotProvider(),
    loadAgents: loadDirectAgents = loadAgents,
    loadSyntheticAgents: loadSynthetic = () => loadSyntheticAgents(),
    loadDefaultAgentAlias = loadConfiguredDefaultAgentAlias,
  } = deps;
  const fallbackProvider = agentAlias ?? 'the default agent';
  try {
    const agents = await loadDirectAgents();
    if (agentAlias === null) {
      const agent = defaultDirectAgent(agents, await loadDefaultAgentAlias());
      return agent ? await evaluateDirectAgent(agent, threshold, snapshotProvider, now()) : { status: 'unknown', provider: fallbackProvider };
    }
    const direct = agents.find(agent => agent.alias === agentAlias && agent.enabled);
    if (direct) return await evaluateDirectAgent(direct, threshold, snapshotProvider, now());

    const pool = (await loadSynthetic()).find(agent => agent.alias === agentAlias && agent.enabled);
    if (!pool) return { status: 'unknown', provider: fallbackProvider };
    const timestamp = now();
    const members = await Promise.all(poolMembers(pool, modelName, agents)
      .map(agent => evaluateDirectAgent(agent, threshold, snapshotProvider, timestamp)));
    return combinePoolCapacity(pool.alias, members, threshold);
  } catch (error) {
    logger.warn({ agentAlias, err: error }, 'Could not evaluate provider capacity for the agent run cost gate');
    return { status: 'unknown', provider: fallbackProvider };
  }
}

export interface AgentRunCostGateOptions {
  now?: () => number;
  /** Deferrals after which a still-limited run is skipped instead. */
  maxDeferrals?: number;
  /** Longest single deferral; the run is re-evaluated after it. */
  deferStepMs?: number;
  loadThreshold?: () => Promise<number>;
  evaluateCapacity?: (agentAlias: string | null, threshold: number, modelName: string | null) => Promise<ProviderCapacity>;
  /** Deferral while the unattended concurrency cap is reached. */
  capDeferStepMs?: number;
  /** Database the active unattended runs are counted in. */
  database?: Knex;
  loadMaxConcurrent?: UnattendedLimitsDependencies['loadMaxConcurrent'];
  loadWindow?: UnattendedLimitsDependencies['loadWindow'];
  countActiveUnattendedRuns?: UnattendedLimitsDependencies['countActiveUnattendedRuns'];
}

function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/** A run being admitted: a new run, or a deferred run being retried (not an admitted run's acting step). */
function isAdmission(run: StoredAgentRun | null | undefined): boolean {
  return !run || run.state === 'deferred';
}

/**
 * The cost gate `triggerAgentRun` consults (`gate` input). Every skip and
 * defer reason is a full sentence: run history shows it verbatim.
 */
export function createAgentRunCostGate({
  now = Date.now,
  maxDeferrals = DEFAULT_AGENT_RUN_MAX_DEFERRALS,
  deferStepMs = DEFAULT_AGENT_RUN_DEFER_STEP_MS,
  loadThreshold = () => loadUsagePauseThreshold(),
  evaluateCapacity = (agentAlias, threshold, modelName) => evaluateProviderCapacity(agentAlias, threshold, { modelName, now }),
  capDeferStepMs = DEFAULT_AGENT_RUN_CAP_DEFER_STEP_MS,
  database,
  loadMaxConcurrent,
  loadWindow,
  countActiveUnattendedRuns,
}: AgentRunCostGateOptions = {}): AgentRunGate {
  const loggedUnknown = new Set<string>();

  const usageDecision = async ({ definition, run }: Parameters<AgentRunGate>[0]): Promise<AgentRunGateDecision> => {
    const threshold = await loadThreshold();
    const capacity = await evaluateCapacity(definition.agentAlias, threshold, definition.modelName);
    const providerKey = `${definition.agentAlias ?? ''}:${capacity.provider}`;
    if (capacity.status === 'unknown') {
      // Fail open, logged once per provider until its usage is known again.
      if (!loggedUnknown.has(providerKey)) {
        loggedUnknown.add(providerKey);
        logger.info({ definitionId: definition.id, agentAlias: definition.agentAlias, provider: capacity.provider, capacity: 'unknown' },
          'Agent run cost gate has no subscription usage for this provider; letting unattended runs proceed');
      }
      return { action: 'proceed' };
    }
    loggedUnknown.delete(providerKey);
    if (capacity.status === 'ok') return { action: 'proceed' };

    const limit = `(pause threshold ${formatPercent(threshold)})`;
    if (atOrOver(capacity.weeklyPercent, threshold)) {
      return {
        action: 'skip',
        reason: `Weekly subscription usage for ${capacity.provider} is at ${formatPercent(capacity.weeklyPercent!)} ${limit}, so this run was skipped; the weekly window will not recover within hours.`,
      };
    }

    const session = capacity.sessionPercent !== undefined
      ? `Session subscription usage for ${capacity.provider} is at ${formatPercent(capacity.sessionPercent)} ${limit}`
      : `Subscription usage for ${capacity.provider} is over the pause threshold of ${formatPercent(threshold)}`;
    const deferrals = run?.deferrals ?? 0;
    if (deferrals >= maxDeferrals) {
      return { action: 'skip', reason: `${session}, and the run was already deferred ${deferrals} times, so it was skipped.` };
    }
    const timestamp = now();
    const afterReset = capacity.resetsInMs !== undefined ? timestamp + capacity.resetsInMs + AGENT_RUN_DEFER_RESET_MARGIN_MS : Infinity;
    const until = Math.min(afterReset, timestamp + deferStepMs);
    return { action: 'defer', until, reason: `${session}, so the run was deferred until ${formatAgentRunUtc(until)}.` };
  };

  return async (context): Promise<AgentRunGateDecision> => {
    // Attended: the person who clicked Run now sees the capacity warning instead.
    if (context.trigger === 'manual') return { action: 'proceed' };

    const usage = await usageDecision(context);
    if (usage.action !== 'proceed' || !isAdmission(context.run)) return usage;

    const limits = await evaluateUnattendedLimits({ now, database, loadMaxConcurrent, loadWindow, countActiveUnattendedRuns });
    return unattendedLimitsDecision(limits, { now: now(), deferrals: context.run?.deferrals ?? 0, maxDeferrals, capDeferStepMs });
  };
}
