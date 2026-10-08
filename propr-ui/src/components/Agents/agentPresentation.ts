import { nextCronOccurrence, validateAgentSchedule, type AgentAutonomyMode, type AgentRunState, type InstanceCatalogAgent } from '@propr/shared';
import type { AgentDefinitionRecord } from '../../api/agentDefinitionsApi';
import { AGENT_DISPLAY, type AgentType } from '../../config/modelDefinitions';
import { formatModelName } from '../../utils/modelDisplay';

/** How the Agents list and editor name and color definitions, schedules and runs. */

export const AUTONOMY_LABELS: Record<AgentAutonomyMode, string> = {
  dry_run: 'Dry run',
  preview: 'Preview',
  auto: 'Auto',
};

export const AUTONOMY_BADGE_CLASSES: Record<AgentAutonomyMode, string> = {
  dry_run: 'border-slate-200 bg-white text-slate-600',
  preview: 'border-amber-300 bg-white text-amber-700',
  auto: 'border-teal-600 bg-teal-600 text-white',
};

export const RUN_STATE_LABELS: Record<AgentRunState, string> = {
  queued: 'Queued',
  deferred: 'Deferred',
  running: 'Running',
  report_ready: 'Report ready',
  awaiting_approval: 'Awaiting approval',
  acting: 'Acting',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/**
 * Run state badges: waiting to start is gray, active work is teal, a waiting
 * human is amber, success is green, failure is red, and runs that ended
 * without a result recede to slate.
 */
export const RUN_STATE_BADGE_CLASSES: Record<AgentRunState, string> = {
  queued: 'border-slate-200 bg-slate-100 text-slate-600',
  deferred: 'border-slate-200 bg-slate-100 text-slate-600',
  running: 'border-teal-200 bg-teal-50 text-teal-700',
  report_ready: 'border-teal-200 bg-teal-50 text-teal-700',
  awaiting_approval: 'border-amber-300 bg-amber-50 text-amber-800',
  acting: 'border-teal-200 bg-teal-50 text-teal-700',
  completed: 'border-green-200 bg-green-50 text-green-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  skipped: 'border-slate-200 bg-white text-slate-500',
  rejected: 'border-slate-200 bg-white text-slate-500',
  cancelled: 'border-slate-200 bg-white text-slate-500',
};

/** One-click schedules offered by the editor, all in UTC. */
export const SCHEDULE_PRESETS = [
  { label: 'Hourly', expression: '0 * * * *' },
  { label: 'Daily 09:00', expression: '0 9 * * *' },
  { label: 'Weekdays 09:00', expression: '0 9 * * 1-5' },
  { label: 'Weekly Mon 09:00', expression: '0 9 * * 1' },
] as const;

/** `integry/propr` → `propr`. */
export const repoShortName = (repository: string): string => repository.split('/').pop() || repository;

const pad = (value: number) => String(value).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Mon 12 Oct 09:00 UTC`: schedules are evaluated in UTC, so they are shown in UTC. */
export const formatUtc = (date: Date): string =>
  `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;

/** `3h`, `25m`, `2d`. */
export const formatDuration = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const NAMED_SCHEDULES: Array<{ match: RegExp; describe: (match: RegExpMatchArray) => string }> = [
  { match: /^(?:@hourly|0 \* \* \* \*)$/, describe: () => 'Hourly' },
  { match: /^(\d{1,2}) (\d{1,2}) \* \* \*$/, describe: ([, minute, hour]) => `Daily ${pad(+hour)}:${pad(+minute)} UTC` },
  { match: /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/, describe: ([, minute, hour]) => `Weekdays ${pad(+hour)}:${pad(+minute)} UTC` },
  { match: /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/, describe: ([, minute, hour, day]) => `Weekly ${WEEKDAYS[+day]} ${pad(+hour)}:${pad(+minute)} UTC` },
  { match: /^@daily$/, describe: () => 'Daily 00:00 UTC' },
  { match: /^@weekly$/, describe: () => 'Weekly Sun 00:00 UTC' },
];

/** A readable name for common cron shapes; anything else is shown as the expression itself. */
export const describeCron = (expression: string): string => {
  const trimmed = expression.trim();
  for (const named of NAMED_SCHEDULES) {
    const match = trimmed.match(named.match);
    if (match) return named.describe(match);
  }
  return `${trimmed} (UTC)`;
};

/** The next fire time of a valid cron expression, or null. */
export const nextScheduledRun = (expression: string, now: Date): Date | null => {
  if (validateAgentSchedule(expression)) return null;
  try {
    return nextCronOccurrence(expression, now);
  } catch {
    return null;
  }
};

/**
 * "Daily 09:00 UTC · next in 3h", or "Manual" when the agent has no active schedule.
 * The stored next run is read when the list loads, so once a page left open
 * passes it, the next occurrence is worked out from the schedule instead.
 */
export const scheduleSummary = (definition: Pick<AgentDefinitionRecord, 'scheduleCron' | 'scheduleEnabled' | 'nextRunAt' | 'enabled'>, now: number): string => {
  if (!definition.scheduleCron || !definition.scheduleEnabled) return 'Manual';
  const name = describeCron(definition.scheduleCron);
  if (!definition.enabled) return `${name} · paused`;
  const stored = definition.nextRunAt !== null && definition.nextRunAt > now ? definition.nextRunAt : null;
  const next = stored ?? nextScheduledRun(definition.scheduleCron, new Date(now))?.getTime() ?? null;
  return next === null ? name : `${name} · next in ${formatDuration(next - now)}`;
};

/** `claude-main` → `Claude Main`: a configured alias read as words. */
const humanizeAlias = (alias: string): string =>
  alias.split(/[-_\s]+/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || alias;

/** `opencode` → `OpenCode`; a runtime the catalogue does not list is humanized. */
export const agentTypeLabel = (type: string): string => AGENT_DISPLAY[type as AgentType]?.label ?? humanizeAlias(type);

/**
 * The name the UI shows for a configured agent: its runtime (`Claude`), with
 * the humanized alias added only when several enabled agents share that
 * runtime (`Claude · Main`). A pool reads as `Fast (pool)`, and an alias
 * missing from the catalog, or without a known runtime, is humanized.
 */
export const agentDisplayName = (alias: string, agents: readonly InstanceCatalogAgent[]): string => {
  const agent = agents.find(candidate => candidate.alias === alias);
  if (agent?.kind === 'synthetic') return `${humanizeAlias(alias)} (pool)`;
  if (!agent?.type) return humanizeAlias(alias);
  const shared = agents.filter(candidate => candidate.type === agent.type).length > 1;
  return shared ? `${agentTypeLabel(agent.type)} · ${humanizeAlias(alias)}` : agentTypeLabel(agent.type);
};

/**
 * What an automation with no coding agent of its own runs on, resolved like
 * the worker does: the configured default alias, else the agent named
 * `default`. Named by its default model, so the editor says which model will
 * run and bill the job; null when the instance has no default agent.
 */
export const defaultRunner = (agents: readonly InstanceCatalogAgent[], configuredAlias: string | null): { label: string; provider: string } | null => {
  const agent = (configuredAlias ? agents.find(candidate => candidate.alias === configuredAlias) : undefined)
    ?? agents.find(candidate => candidate.alias === 'default');
  if (!agent) return null;
  const name = agent.defaultModel ? formatModelName(agent.defaultModel) : agentDisplayName(agent.alias, agents);
  return { label: `${name} (Default)`, provider: agent.type ?? agent.alias };
};

/** What runs an agent, for the list: the model's name, else the agent's, else the instance default. */
export const runnerLabel = (definition: Pick<AgentDefinitionRecord, 'agentAlias' | 'modelName'>, agents: readonly InstanceCatalogAgent[]): string => {
  if (definition.modelName) return formatModelName(definition.modelName);
  if (definition.agentAlias) return agentDisplayName(definition.agentAlias, agents);
  return 'Default agent';
};
