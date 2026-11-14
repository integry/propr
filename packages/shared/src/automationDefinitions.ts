import { automationExtensionsSchema, type AutomationExtensions } from './extensionLibrary.js';
/**
 * Authoritative automation definition contract shared by the REST API, MCP, web UI,
 * CLI, worker and daemon scheduler. An automation is a saved, reusable definition
 * that runs on demand or on a schedule and produces a free-form report; every
 * surface validates against these values so accepted options cannot drift.
 */

import type { AgentType } from './modelDefinitions.js';
import { GOAL_REPOSITORY_PATTERN } from './goalCreation.js';
import {
  AUTOMATION_SCHEDULE_MAX_LENGTH,
  CRON_MACROS,
  MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES,
  validateAutomationSchedule,
} from './cronSchedule.js';
import {
  AUTOMATION_REPORT_MIN_NOVEL_CHARS,
  AUTOMATION_REPORT_NOVELTIES,
  DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD,
  type AutomationReportNovelty,
} from './automationRunProductivity.js';

/**
 * Each capability is separately togglable on a definition. `merge` concerns the
 * acting step only: it adds the MCP `merge` scope to that step's grant, so the
 * acting agent may merge pull requests that pass review and checks.
 */
export const AUTOMATION_CAPABILITIES = ['repository_read', 'web', 'propr_mcp', 'merge'] as const;
export type AutomationCapability = typeof AUTOMATION_CAPABILITIES[number];

/**
 * dry_run: report only. preview: the acting step waits for approval. auto: the
 * acting step runs immediately. The acting step always runs with propr_mcp;
 * the report step only gets it when the definition enables the capability.
 */
export const AUTOMATION_AUTONOMY_MODES = ['dry_run', 'preview', 'auto'] as const;
export type AutomationAutonomyMode = typeof AUTOMATION_AUTONOMY_MODES[number];

/** `event`: started by an event a definition subscribed to (see `eventTriggers`). */
export const AUTOMATION_RUN_TRIGGERS = ['manual', 'schedule', 'api', 'mcp', 'cli', 'event'] as const;
export type AutomationRunTrigger = typeof AUTOMATION_RUN_TRIGGERS[number];

/** Events a definition can subscribe to. Each is opt-in; a definition without `eventTriggers` reacts to none. */
export const AUTOMATION_TRIGGER_EVENTS = ['plan.issue_blocked'] as const;
export type AutomationTriggerEventType = typeof AUTOMATION_TRIGGER_EVENTS[number];

/** Why an epic queue issue is blocked: the reason kinds a `plan.issue_blocked` trigger can be limited to. */
export const PLAN_ISSUE_BLOCKED_REASON_KINDS = [
  'closed_unmerged',
  'missing_from_plan',
  'dispatch_failed',
  'agent_blocked',
  'awaiting_human_merge',
  'label_handoff',
  'setup_not_ready',
] as const;
export type PlanIssueBlockedReasonKind = typeof PLAN_ISSUE_BLOCKED_REASON_KINDS[number];

/**
 * Loop bound: at most this many event-started runs of one definition for the same issue of
 * the same plan. Later blocked events for that issue are recorded as skipped runs, so a run
 * whose own actions block the issue again cannot trigger itself without bound.
 */
export const MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE = 3;

/**
 * An event subscription. `repositories` and `reasonKinds` narrow it; empty means every
 * repository of the definition and every reason kind. A subscription never reaches beyond
 * the definition's own repositories.
 */
export interface AutomationEventTrigger {
  event: AutomationTriggerEventType;
  repositories: string[];
  reasonKinds: PlanIssueBlockedReasonKind[];
}

/** The event a run was started by, handed to the run as structured input. */
export interface AutomationTriggerEvent {
  type: 'plan.issue_blocked';
  /** The durable blocked-event id; one run per definition per id. */
  eventId: number;
  repository: string;
  planId: string;
  planName: string | null;
  executionId: string;
  issueNumber: number;
  reasonKind: string;
  reason: string;
  planUrl: string;
  issueUrl: string;
  /** Epoch milliseconds. */
  occurredAt: number;
}

export const AUTOMATION_RUN_STATES = [
  'queued',
  'deferred',
  'running',
  'report_ready',
  'awaiting_approval',
  'acting',
  'completed',
  'failed',
  'skipped',
  'rejected',
  'cancelled',
] as const;
export type AutomationRunState = typeof AUTOMATION_RUN_STATES[number];

export const TERMINAL_AUTOMATION_RUN_STATES = ['completed', 'failed', 'skipped', 'rejected', 'cancelled'] as const satisfies readonly AutomationRunState[];
export type TerminalAutomationRunState = typeof TERMINAL_AUTOMATION_RUN_STATES[number];

/** Agent types that can receive an MCP server config at launch (v1). */
export const AGENT_TYPES_SUPPORTING_PROPR_MCP = ['claude', 'codex'] as const satisfies readonly AgentType[];

export const DEFAULT_AUTOMATION_CAPABILITIES: readonly AutomationCapability[] = ['repository_read'];
export const DEFAULT_AUTOMATION_AUTONOMY_MODE: AutomationAutonomyMode = 'dry_run';

export const AUTOMATION_NAME_MAX_LENGTH = 100;
export const AUTOMATION_DESCRIPTION_MAX_LENGTH = 1_000;
export const AUTOMATION_PROMPT_MAX_LENGTH = 32_768;
export const MAX_AUTOMATION_REPOSITORIES = 10;
export const MAX_AUTOMATION_ATTACHMENTS = 10;
/** How many previous reports may be fed back into a run, and their combined size. */
export const MAX_AUTOMATION_PREVIOUS_REPORTS = 5;
export const DEFAULT_AUTOMATION_PREVIOUS_REPORTS = 0;
export const AUTOMATION_PREVIOUS_REPORTS_MAX_CHARACTERS = 50_000;
/** Each previous report fed into a run is cut to this size with a visible marker. */
export const AUTOMATION_PREVIOUS_REPORT_MAX_CHARS = AUTOMATION_PREVIOUS_REPORTS_MAX_CHARACTERS / MAX_AUTOMATION_PREVIOUS_REPORTS;
/** Upper bound on the assembled report-run prompt. */
export const AUTOMATION_REPORT_PROMPT_MAX_CHARS = 200_000;
/** Stored report size; longer output is truncated and stays available in the task logs. */
export const AUTOMATION_REPORT_MAX_CHARS = 100_000;
/** Optional guidance an approver may add to the acting step of a preview run. */
export const AUTOMATION_ACTION_OPERATOR_NOTE_MAX_CHARS = 2_000;
/** Stored acting-step summary size; the full output stays available in the task logs. */
export const AUTOMATION_ACTION_SUMMARY_MAX_CHARS = 20_000;

export interface AutomationDefinitionInput {
  /** Library servers (names) and skill bundles (ids) added on top of what applies automatically; null clears them. */
  extensions?: AutomationExtensions | null;
  name: string;
  description?: string | null;
  prompt: string;
  repositories?: string[];
  capabilities?: AutomationCapability[];
  autonomy?: AutomationAutonomyMode;
  /** 5-field cron expression or macro evaluated in UTC; null disables scheduling. */
  schedule?: string | null;
  enabled?: boolean;
  /** Configured agent id and model; resolved against the live agent config by the API. */
  agentId?: string | null;
  model?: string | null;
  previousReportCount?: number;
  /** Event subscriptions; empty or absent means the definition reacts to no event. */
  eventTriggers?: AutomationEventTrigger[];
  /** Turn the schedule off when the unproductive-run notification fires; default false. */
  pauseWhenUnproductive?: boolean;
}

export interface AutomationDefinition {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  repositories: string[];
  capabilities: AutomationCapability[];
  autonomy: AutomationAutonomyMode;
  schedule: string | null;
  enabled: boolean;
  agentId: string | null;
  model: string | null;
  previousReportCount: number;
  eventTriggers: AutomationEventTrigger[];
  pauseWhenUnproductive: boolean;
  /** Library items this automation adds explicitly. */
  extensions: AutomationExtensions;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface AutomationRunAttachment {
  id: string;
  runId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AutomationRun {
  id: string;
  automationDefinitionId: string;
  state: AutomationRunState;
  trigger: AutomationRunTrigger;
  /** For an `event` run: the event that started it, as handed to the run. */
  triggerEvent: AutomationTriggerEvent | null;
  /** Autonomy captured when the run was queued, so later edits do not change it. */
  autonomy: AutomationAutonomyMode;
  /** Task id of the isolated report run, once spawned. */
  reportTaskId: string | null;
  /** Task id of the separate acting run (preview/auto), once spawned. */
  actingTaskId: string | null;
  report: string | null;
  attachments: AutomationRunAttachment[];
  error: string | null;
  triggeredBy: string | null;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Normalised SHA-256 of the stored report; null before a report or for runs older than the flag. */
  reportHash: string | null;
  reportNovelty: AutomationReportNovelty | null;
  /** Mutating MCP operations the acting step performed; 0 is a no-op acting step. */
  actingMutations: number | null;
}

/** Machine-readable description of definition options for capability discovery. */
export const AUTOMATION_DEFINITION_CONTRACT = {
  capabilities: AUTOMATION_CAPABILITIES,
  defaultCapabilities: DEFAULT_AUTOMATION_CAPABILITIES,
  proprMcpAgentTypes: AGENT_TYPES_SUPPORTING_PROPR_MCP,
  autonomyModes: AUTOMATION_AUTONOMY_MODES,
  defaultAutonomyMode: DEFAULT_AUTOMATION_AUTONOMY_MODE,
  actingStepCapabilities: ['propr_mcp'],
  extensions: {
    fields: ['servers', 'skills'],
    servers: 'extension library server names',
    skills: 'extension library skill bundle ids',
    permission: 'instance.manage_settings',
    runtimes: ['claude', 'codex'],
  },
  runTriggers: AUTOMATION_RUN_TRIGGERS,
  runStates: AUTOMATION_RUN_STATES,
  terminalRunStates: TERMINAL_AUTOMATION_RUN_STATES,
  nameMaxCharacters: AUTOMATION_NAME_MAX_LENGTH,
  descriptionMaxCharacters: AUTOMATION_DESCRIPTION_MAX_LENGTH,
  promptMaxCharacters: AUTOMATION_PROMPT_MAX_LENGTH,
  maxRepositories: MAX_AUTOMATION_REPOSITORIES,
  repositoryFormat: 'owner/repo',
  maxAttachments: MAX_AUTOMATION_ATTACHMENTS,
  previousReports: {
    max: MAX_AUTOMATION_PREVIOUS_REPORTS,
    default: DEFAULT_AUTOMATION_PREVIOUS_REPORTS,
    maxCharacters: AUTOMATION_PREVIOUS_REPORTS_MAX_CHARACTERS,
  },
  eventTriggers: {
    events: AUTOMATION_TRIGGER_EVENTS,
    /** One subscription per event; filters are optional and only narrow the definition's repositories. */
    maxPerEvent: 1,
    reasonKinds: { 'plan.issue_blocked': PLAN_ISSUE_BLOCKED_REASON_KINDS },
    requiresRepositories: true,
    maxRunsPerIssue: MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE,
    delivery: 'at-most-once per event and definition; events while the definition is disabled are not run later',
  },
  unproductiveRuns: {
    reportNovelties: AUTOMATION_REPORT_NOVELTIES,
    minReportCharacters: AUTOMATION_REPORT_MIN_NOVEL_CHARS,
    defaultStreakThreshold: DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD,
    countedTriggers: ['schedule'],
  },
  schedule: {
    format: 'cron-5-field',
    timezone: 'UTC',
    macros: Object.keys(CRON_MACROS),
    maxCharacters: AUTOMATION_SCHEDULE_MAX_LENGTH,
    minIntervalMinutes: MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES,
  },
} as const;

export function isAutomationCapability(value: unknown): value is AutomationCapability {
  return AUTOMATION_CAPABILITIES.includes(value as AutomationCapability);
}

export function isAutomationAutonomyMode(value: unknown): value is AutomationAutonomyMode {
  return AUTOMATION_AUTONOMY_MODES.includes(value as AutomationAutonomyMode);
}

export function isAutomationRunTrigger(value: unknown): value is AutomationRunTrigger {
  return AUTOMATION_RUN_TRIGGERS.includes(value as AutomationRunTrigger);
}

export function isAutomationTriggerEventType(value: unknown): value is AutomationTriggerEventType {
  return AUTOMATION_TRIGGER_EVENTS.includes(value as AutomationTriggerEventType);
}

export function isPlanIssueBlockedReasonKind(value: unknown): value is PlanIssueBlockedReasonKind {
  return PLAN_ISSUE_BLOCKED_REASON_KINDS.includes(value as PlanIssueBlockedReasonKind);
}

export function isAutomationRunState(value: unknown): value is AutomationRunState {
  return AUTOMATION_RUN_STATES.includes(value as AutomationRunState);
}

export function isTerminalAutomationRunState(value: unknown): value is TerminalAutomationRunState {
  return TERMINAL_AUTOMATION_RUN_STATES.includes(value as TerminalAutomationRunState);
}

export function agentTypeSupportsProprMcp(agentType: unknown): boolean {
  return AGENT_TYPES_SUPPORTING_PROPR_MCP.includes(agentType as typeof AGENT_TYPES_SUPPORTING_PROPR_MCP[number]);
}

/** Only the UI "Run now" (manual) trigger is attended; everything else runs unattended. */
export function isUnattendedTrigger(trigger: AutomationRunTrigger): boolean {
  return trigger !== 'manual';
}

function has(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

function validateOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > maxLength) return `${field} must be a string of at most ${maxLength} characters`;
  return null;
}

/**
 * Validate automation definition fields. Returns a user-facing error, or null when
 * the input satisfies the contract. With `partial`, only fields that are
 * present are checked (updates). Agent/model support, including whether the
 * agent type supports propr_mcp, is checked separately against the live
 * agent configuration.
 */
export function validateAutomationDefinitionInput(input: unknown, options: { partial?: boolean } = {}): string | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return 'automation definition must be an object';
  const body = input as Record<string, unknown>;
  if ('extensionProfile' in body) return 'extensionProfile was replaced by extensions: { servers, skills }';
  if (body.extensions != null && !automationExtensionsSchema.safeParse(body.extensions).success) return 'extensions must be { servers: library server names, skills: skill bundle ids } without duplicates';
  const partial = options.partial === true;

  if (!partial || has(body, 'name')) {
    if (typeof body.name !== 'string' || body.name.trim().length < 1) return 'name is required';
    if (body.name.length > AUTOMATION_NAME_MAX_LENGTH) return `name must be at most ${AUTOMATION_NAME_MAX_LENGTH} characters`;
  }
  const descriptionError = validateOptionalText(body.description, 'description', AUTOMATION_DESCRIPTION_MAX_LENGTH);
  if (descriptionError) return descriptionError;
  if (!partial || has(body, 'prompt')) {
    if (typeof body.prompt !== 'string' || body.prompt.trim().length < 1) return 'prompt is required';
    if (body.prompt.length > AUTOMATION_PROMPT_MAX_LENGTH) return `prompt must be at most ${AUTOMATION_PROMPT_MAX_LENGTH} characters`;
  }

  if (has(body, 'repositories')) {
    const repositories = body.repositories;
    if (!Array.isArray(repositories)) return 'repositories must be an array';
    if (repositories.length > MAX_AUTOMATION_REPOSITORIES) return `repositories must contain at most ${MAX_AUTOMATION_REPOSITORIES} entries`;
    for (const repository of repositories) {
      if (typeof repository !== 'string' || !GOAL_REPOSITORY_PATTERN.test(repository)) return 'repositories must be in owner/repo format';
    }
    if (new Set(repositories.map((repository: string) => repository.toLowerCase())).size !== repositories.length) {
      return 'repositories must not contain duplicates';
    }
  }

  if (has(body, 'capabilities')) {
    const capabilities = body.capabilities;
    if (!Array.isArray(capabilities)) return 'capabilities must be an array';
    for (const capability of capabilities) {
      if (!isAutomationCapability(capability)) return `capabilities must be one of: ${AUTOMATION_CAPABILITIES.join(', ')}`;
    }
    if (new Set(capabilities).size !== capabilities.length) return 'capabilities must not contain duplicates';
  }

  if (has(body, 'autonomy') && !isAutomationAutonomyMode(body.autonomy)) {
    return `autonomy must be one of: ${AUTOMATION_AUTONOMY_MODES.join(', ')}`;
  }

  if (body.schedule != null) {
    const scheduleError = validateAutomationSchedule(body.schedule);
    if (scheduleError) return scheduleError;
  }

  if (has(body, 'enabled') && typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
  if (has(body, 'pauseWhenUnproductive') && typeof body.pauseWhenUnproductive !== 'boolean') return 'pauseWhenUnproductive must be a boolean';
  if (body.agentId != null && (typeof body.agentId !== 'string' || !body.agentId)) return 'agentId must be a non-empty string';
  if (body.model != null && (typeof body.model !== 'string' || !body.model)) return 'model must be a non-empty string';

  if (has(body, 'eventTriggers')) {
    const eventTriggersError = validateAutomationEventTriggers(body.eventTriggers);
    if (eventTriggersError) return eventTriggersError;
    if (has(body, 'repositories')) {
      const scopeError = validateAutomationEventTriggerScope(body.eventTriggers as AutomationEventTrigger[], body.repositories as string[]);
      if (scopeError) return scopeError;
    }
  }

  if (has(body, 'previousReportCount')) {
    const count = body.previousReportCount;
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > MAX_AUTOMATION_PREVIOUS_REPORTS) {
      return `previousReportCount must be an integer from 0 to ${MAX_AUTOMATION_PREVIOUS_REPORTS}`;
    }
  }

  return null;
}

function validateUniqueList(value: unknown, field: string, check: (item: unknown) => string | null): string | null {
  if (!Array.isArray(value)) return `${field} must be an array`;
  for (const item of value) {
    const error = check(item);
    if (error) return error;
  }
  const keys = value.map(item => String(item).toLowerCase());
  if (new Set(keys).size !== keys.length) return `${field} must not contain duplicates`;
  return null;
}

/** Shape check of `eventTriggers`; the repository scope is checked by `validateAutomationEventTriggerScope`. */
export function validateAutomationEventTriggers(value: unknown): string | null {
  if (!Array.isArray(value)) return 'eventTriggers must be an array';
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return 'eventTriggers entries must be objects';
    const trigger = entry as Record<string, unknown>;
    const unknownKey = Object.keys(trigger).find(key => !['event', 'repositories', 'reasonKinds'].includes(key));
    if (unknownKey) return `eventTriggers entries do not accept ${unknownKey}`;
    if (!isAutomationTriggerEventType(trigger.event)) return `eventTriggers event must be one of: ${AUTOMATION_TRIGGER_EVENTS.join(', ')}`;
    if (seen.has(trigger.event)) return 'eventTriggers must not subscribe to the same event twice';
    seen.add(trigger.event);
    if (trigger.repositories !== undefined) {
      if (Array.isArray(trigger.repositories) && trigger.repositories.length > MAX_AUTOMATION_REPOSITORIES) {
        return `eventTriggers repositories must contain at most ${MAX_AUTOMATION_REPOSITORIES} entries`;
      }
      const error = validateUniqueList(trigger.repositories, 'eventTriggers repositories', repository =>
        typeof repository === 'string' && GOAL_REPOSITORY_PATTERN.test(repository) ? null : 'eventTriggers repositories must be in owner/repo format');
      if (error) return error;
    }
    if (trigger.reasonKinds !== undefined) {
      const error = validateUniqueList(trigger.reasonKinds, 'eventTriggers reasonKinds', kind =>
        isPlanIssueBlockedReasonKind(kind) ? null : `eventTriggers reasonKinds must be one of: ${PLAN_ISSUE_BLOCKED_REASON_KINDS.join(', ')}`);
      if (error) return error;
    }
  }
  return null;
}

/**
 * An event never widens what a definition may do: a definition that subscribes to an event
 * must name its repositories, and a subscription's repository filter must stay within them.
 */
export function validateAutomationEventTriggerScope(eventTriggers: readonly AutomationEventTrigger[], repositories: readonly string[]): string | null {
  if (eventTriggers.length === 0) return null;
  if (repositories.length === 0) return 'An automation with event triggers must name the repositories it concerns';
  const allowed = new Set(repositories.map(repository => repository.toLowerCase()));
  const outside = eventTriggers.flatMap(trigger => trigger.repositories ?? []).filter(repository => !allowed.has(repository.toLowerCase()));
  if (outside.length > 0) return `Event trigger repositories must be repositories of the automation: ${[...new Set(outside)].join(', ')}`;
  return null;
}

/** Normalizes stored or submitted subscriptions: missing filters become empty lists. */
export function normalizeAutomationEventTriggers(value: unknown): AutomationEventTrigger[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const trigger = entry as Partial<AutomationEventTrigger> | null;
    if (!trigger || !isAutomationTriggerEventType(trigger.event)) return [];
    return [{
      event: trigger.event,
      repositories: Array.isArray(trigger.repositories) ? trigger.repositories.filter((repository): repository is string => typeof repository === 'string') : [],
      reasonKinds: Array.isArray(trigger.reasonKinds) ? trigger.reasonKinds.filter(isPlanIssueBlockedReasonKind) : [],
    }];
  });
}

/**
 * Whether a subscription covers an event: the event's repository is one of the definition's
 * (and of the filter, when it has one), and its reason kind matches the filter, when it has one.
 */
export function automationEventTriggerMatches(
  trigger: AutomationEventTrigger,
  definitionRepositories: readonly string[],
  event: { type: AutomationTriggerEventType; repository: string; reasonKind: string },
): boolean {
  if (trigger.event !== event.type) return false;
  const repository = event.repository.toLowerCase();
  if (!definitionRepositories.some(candidate => candidate.toLowerCase() === repository)) return false;
  if (trigger.repositories.length > 0 && !trigger.repositories.some(candidate => candidate.toLowerCase() === repository)) return false;
  return trigger.reasonKinds.length === 0 || (trigger.reasonKinds as readonly string[]).includes(event.reasonKind);
}
