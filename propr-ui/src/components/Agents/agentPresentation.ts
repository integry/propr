import { nextCronOccurrence, validateAutomationSchedule, type AutomationAutonomyMode, type AutomationRunState, type InstanceCatalogAgent } from '@propr/shared';
import type { AutomationDefinitionRecord } from '../../api/automationDefinitionsApi';
import { AGENT_DISPLAY, type AgentType } from '../../config/modelDefinitions';
import { formatModelName } from '../../utils/modelDisplay';

/** How the Agents list and editor name and color definitions, schedules and runs. */

export const AUTONOMY_LABELS: Record<AutomationAutonomyMode, string> = {
  dry_run: 'Report only',
  preview: 'Preview',
  auto: 'Auto',
};

export const AUTONOMY_BADGE_CLASSES: Record<AutomationAutonomyMode, string> = {
  dry_run: 'border-slate-200 bg-white text-slate-600',
  preview: 'border-amber-300 bg-white text-amber-700',
  auto: 'border-teal-600 bg-teal-600 text-white',
};

export const RUN_STATE_LABELS: Record<AutomationRunState, string> = {
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
export const RUN_STATE_BADGE_CLASSES: Record<AutomationRunState, string> = {
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

/** A schedule in words: `title` heads a list row ("Weekdays 07:00 UTC"), `phrase` follows "Scheduled ·" ("weekdays 07:00 UTC"). */
interface ScheduleWords { title: string; phrase: string }

const CRON_MACRO_EXPANSIONS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const NUMBER = /^\d{1,2}$/;
const STEP = /^\*\/(\d{1,2})$/;

/** `09:00`, `09:00 and 17:00`, `08:00, 12:00 and 16:00`; null unless each hour is a plain number. */
const timesOf = (minute: string, hours: string): string | null => {
  const list = hours.split(',');
  if (!NUMBER.test(minute) || +minute > 59 || !list.every(hour => NUMBER.test(hour) && +hour <= 23)) return null;
  const times = list.map(hour => `${pad(+hour)}:${pad(+minute)}`);
  return times.length === 1 ? times[0] : `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`;
};

/** Day-of-week numbers (0 or 7 is Sunday) of a plain list or range, in week order; null for anything else. */
const weekdaysOf = (field: string): number[] | null => {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.match(/^(\d)(?:-(\d))?$/);
    if (!range) return null;
    const from = +range[1];
    const to = range[2] === undefined ? from : +range[2];
    if (from > 7 || to > 7 || to < from) return null;
    for (let day = from; day <= to; day += 1) days.add(day % 7);
  }
  return [...days].sort((left, right) => left - right);
};

const describeDays = (field: string, time: string): ScheduleWords | null => {
  if (field === '*') return { title: `Daily ${time} UTC`, phrase: `every day ${time} UTC` };
  const days = weekdaysOf(field);
  if (!days) return null;
  const key = days.join(',');
  if (key === '1,2,3,4,5') return { title: `Weekdays ${time} UTC`, phrase: `weekdays ${time} UTC` };
  if (key === '0,6') return { title: `Weekends ${time} UTC`, phrase: `weekends ${time} UTC` };
  if (key === '0,1,2,3,4,5,6') return { title: `Daily ${time} UTC`, phrase: `every day ${time} UTC` };
  // Monday first, as a week is read.
  const names = [...days.filter(day => day !== 0), ...days.filter(day => day === 0)].map(day => WEEKDAYS[day]).join(', ');
  return days.length === 1
    ? { title: `Weekly ${names} ${time} UTC`, phrase: `every ${names} ${time} UTC` }
    : { title: `${names} ${time} UTC`, phrase: `every ${names} ${time} UTC` };
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;

const words = (title: string): ScheduleWords => ({ title, phrase: lowerFirst(title) });
const isEvery = (...fields: string[]) => fields.every(field => field === '*');
const validMinute = (minute: string) => NUMBER.test(minute) && +minute <= 59;

/** Every few minutes (a step in the minute part). */
const describeMinutes = ([minute, ...rest]: string[]): ScheduleWords | null => {
  const step = minute.match(STEP);
  // `*/22` runs at :00, :22 and :44, then again 16 minutes later: only a step dividing the hour is an even interval.
  return step && 60 % +step[1] === 0 && isEvery(...rest) ? words(`Every ${plural(+step[1], 'minute')}`) : null;
};

/** `0 6 1 * *`: one day a month. */
const describeMonthly = ([minute, hour, dayOfMonth, month, dayOfWeek]: string[]): ScheduleWords | null => {
  const time = timesOf(minute, hour);
  const day = NUMBER.test(dayOfMonth) ? +dayOfMonth : 0;
  if (!time || !isEvery(month, dayOfWeek) || day < 1 || day > 31) return null;
  return { title: `Monthly on day ${day}, ${time} UTC`, phrase: `monthly on day ${day}, ${time} UTC` };
};

/** Every hour, or every few hours (a step in the hour part), on the minute given. */
const describeHours = ([minute, hour, , , dayOfWeek]: string[]): ScheduleWords | null => {
  if (dayOfWeek !== '*') return null;
  const past = +minute === 0 ? '' : ` at :${pad(+minute)}`;
  const step = hour.match(STEP);
  if (hour === '*' || step?.[1] === '1') return { title: `Hourly${past}`, phrase: `every hour${past}` };
  // `*/5` runs at 00, 05, 10, 15 and 20, then 4 hours later at midnight: only a step dividing the day is an even interval.
  return step && 24 % +step[1] === 0 ? words(`Every ${plural(+step[1], 'hour')}${past}`) : null;
};

/** Words for a preset or a simple pattern; null for an expression that does not read as one. */
export const describeSchedule = (expression: string): ScheduleWords | null => {
  const trimmed = expression.trim();
  const fields = (CRON_MACRO_EXPANSIONS[trimmed.toLowerCase()] ?? trimmed).split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = describeMinutes(fields);
  if (minutes) return minutes;
  if (!isEvery(fields[2], fields[3])) return describeMonthly(fields);
  if (!validMinute(fields[0])) return null;
  const hours = describeHours(fields);
  if (hours) return hours;
  const time = timesOf(fields[0], fields[1]);
  return time ? describeDays(fields[4], time) : null;
};

/** A readable name for a schedule (a list row, a template card); anything else is shown as the expression itself. */
export const describeCron = (expression: string): string =>
  describeSchedule(expression)?.title ?? `${expression.trim()} (UTC)`;

/** The schedule as it follows "Scheduled ·" on a run: `every day 09:00 UTC`. */
export const scheduleSentence = (expression: string): string =>
  describeSchedule(expression)?.phrase ?? `${expression.trim()} (UTC)`;

/** The next fire time of a valid cron expression, or null. */
export const nextScheduledRun = (expression: string, now: Date): Date | null => {
  if (validateAutomationSchedule(expression)) return null;
  try {
    return nextCronOccurrence(expression, now);
  } catch {
    return null;
  }
};

/** The cron behind a schedule shown in words, for its tooltip; null when there is no schedule. */
export const scheduleTooltip = (definition: Pick<AutomationDefinitionRecord, 'scheduleCron' | 'scheduleEnabled'>): string | null =>
  definition.scheduleCron && definition.scheduleEnabled ? `${definition.scheduleCron} (UTC)` : null;

/**
 * "Daily 09:00 UTC · next in 3h", "On blocked issue" for an automation that only runs on its
 * event trigger, or "Manual" when it has neither.
 * The stored next run is read when the list loads, so once a page left open
 * passes it, the next occurrence is worked out from the schedule instead.
 */
export const scheduleSummary = (definition: Pick<AutomationDefinitionRecord, 'scheduleCron' | 'scheduleEnabled' | 'nextRunAt' | 'enabled' | 'eventTriggers'>, now: number): string => {
  if (!definition.scheduleCron || !definition.scheduleEnabled) {
    if (!definition.eventTriggers?.length) return 'Manual';
    return definition.enabled ? 'On blocked issue' : 'On blocked issue · paused';
  }
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
export const runnerLabel = (definition: Pick<AutomationDefinitionRecord, 'agentAlias' | 'modelName'>, agents: readonly InstanceCatalogAgent[]): string => {
  if (definition.modelName) return formatModelName(definition.modelName);
  if (definition.agentAlias) return agentDisplayName(definition.agentAlias, agents);
  return 'Default agent';
};
