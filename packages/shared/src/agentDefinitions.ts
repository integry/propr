/**
 * Authoritative agent definition contract shared by the REST API, MCP, web UI,
 * CLI, worker and daemon scheduler. An agent is a saved, reusable definition
 * that runs on demand or on a schedule and produces a free-form report; every
 * surface validates against these values so accepted options cannot drift.
 */

import type { AgentType } from './modelDefinitions.js';
import { GOAL_REPOSITORY_PATTERN } from './goalCreation.js';
import {
  AGENT_SCHEDULE_MAX_LENGTH,
  CRON_MACROS,
  MIN_AGENT_SCHEDULE_INTERVAL_MINUTES,
  validateAgentSchedule,
} from './cronSchedule.js';

/** Each capability is separately togglable on a definition. */
export const AGENT_CAPABILITIES = ['repository_read', 'web', 'propr_mcp'] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

/**
 * dry_run: report only. preview: the acting step waits for approval. auto: the
 * acting step runs immediately. The acting step always runs with propr_mcp;
 * the report step only gets it when the definition enables the capability.
 */
export const AGENT_AUTONOMY_MODES = ['dry_run', 'preview', 'auto'] as const;
export type AgentAutonomyMode = typeof AGENT_AUTONOMY_MODES[number];

export const AGENT_RUN_TRIGGERS = ['manual', 'schedule', 'api', 'mcp', 'cli'] as const;
export type AgentRunTrigger = typeof AGENT_RUN_TRIGGERS[number];

export const AGENT_RUN_STATES = [
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
export type AgentRunState = typeof AGENT_RUN_STATES[number];

export const TERMINAL_AGENT_RUN_STATES = ['completed', 'failed', 'skipped', 'rejected', 'cancelled'] as const satisfies readonly AgentRunState[];
export type TerminalAgentRunState = typeof TERMINAL_AGENT_RUN_STATES[number];

/** Agent types that can receive an MCP server config at launch (v1). */
export const AGENT_TYPES_SUPPORTING_PROPR_MCP = ['claude', 'codex'] as const satisfies readonly AgentType[];

export const DEFAULT_AGENT_CAPABILITIES: readonly AgentCapability[] = ['repository_read'];
export const DEFAULT_AGENT_AUTONOMY_MODE: AgentAutonomyMode = 'dry_run';

export const AGENT_NAME_MAX_LENGTH = 100;
export const AGENT_DESCRIPTION_MAX_LENGTH = 1_000;
export const AGENT_PROMPT_MAX_LENGTH = 32_768;
export const MAX_AGENT_REPOSITORIES = 10;
export const MAX_AGENT_ATTACHMENTS = 10;
/** How many previous reports may be fed back into a run, and their combined size. */
export const MAX_AGENT_PREVIOUS_REPORTS = 5;
export const DEFAULT_AGENT_PREVIOUS_REPORTS = 0;
export const AGENT_PREVIOUS_REPORTS_MAX_CHARACTERS = 50_000;
/** Stored report size; longer output is truncated and stays available in the task logs. */
export const AGENT_REPORT_MAX_CHARS = 100_000;

export interface AgentDefinitionInput {
  name: string;
  description?: string | null;
  prompt: string;
  repositories?: string[];
  capabilities?: AgentCapability[];
  autonomy?: AgentAutonomyMode;
  /** 5-field cron expression or macro evaluated in UTC; null disables scheduling. */
  schedule?: string | null;
  enabled?: boolean;
  /** Configured agent id and model; resolved against the live agent config by the API. */
  agentId?: string | null;
  model?: string | null;
  previousReportCount?: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  repositories: string[];
  capabilities: AgentCapability[];
  autonomy: AgentAutonomyMode;
  schedule: string | null;
  enabled: boolean;
  agentId: string | null;
  model: string | null;
  previousReportCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface AgentRunAttachment {
  id: string;
  runId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentDefinitionId: string;
  state: AgentRunState;
  trigger: AgentRunTrigger;
  /** Autonomy captured when the run was queued, so later edits do not change it. */
  autonomy: AgentAutonomyMode;
  /** Task id of the isolated report run, once spawned. */
  reportTaskId: string | null;
  /** Task id of the separate acting run (preview/auto), once spawned. */
  actingTaskId: string | null;
  report: string | null;
  attachments: AgentRunAttachment[];
  error: string | null;
  triggeredBy: string | null;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Machine-readable description of definition options for capability discovery. */
export const AGENT_DEFINITION_CONTRACT = {
  capabilities: AGENT_CAPABILITIES,
  defaultCapabilities: DEFAULT_AGENT_CAPABILITIES,
  proprMcpAgentTypes: AGENT_TYPES_SUPPORTING_PROPR_MCP,
  autonomyModes: AGENT_AUTONOMY_MODES,
  defaultAutonomyMode: DEFAULT_AGENT_AUTONOMY_MODE,
  actingStepCapabilities: ['propr_mcp'],
  runTriggers: AGENT_RUN_TRIGGERS,
  runStates: AGENT_RUN_STATES,
  terminalRunStates: TERMINAL_AGENT_RUN_STATES,
  nameMaxCharacters: AGENT_NAME_MAX_LENGTH,
  descriptionMaxCharacters: AGENT_DESCRIPTION_MAX_LENGTH,
  promptMaxCharacters: AGENT_PROMPT_MAX_LENGTH,
  maxRepositories: MAX_AGENT_REPOSITORIES,
  repositoryFormat: 'owner/repo',
  maxAttachments: MAX_AGENT_ATTACHMENTS,
  previousReports: {
    max: MAX_AGENT_PREVIOUS_REPORTS,
    default: DEFAULT_AGENT_PREVIOUS_REPORTS,
    maxCharacters: AGENT_PREVIOUS_REPORTS_MAX_CHARACTERS,
  },
  schedule: {
    format: 'cron-5-field',
    timezone: 'UTC',
    macros: Object.keys(CRON_MACROS),
    maxCharacters: AGENT_SCHEDULE_MAX_LENGTH,
    minIntervalMinutes: MIN_AGENT_SCHEDULE_INTERVAL_MINUTES,
  },
} as const;

export function isAgentCapability(value: unknown): value is AgentCapability {
  return AGENT_CAPABILITIES.includes(value as AgentCapability);
}

export function isAgentAutonomyMode(value: unknown): value is AgentAutonomyMode {
  return AGENT_AUTONOMY_MODES.includes(value as AgentAutonomyMode);
}

export function isAgentRunTrigger(value: unknown): value is AgentRunTrigger {
  return AGENT_RUN_TRIGGERS.includes(value as AgentRunTrigger);
}

export function isAgentRunState(value: unknown): value is AgentRunState {
  return AGENT_RUN_STATES.includes(value as AgentRunState);
}

export function isTerminalAgentRunState(value: unknown): value is TerminalAgentRunState {
  return TERMINAL_AGENT_RUN_STATES.includes(value as TerminalAgentRunState);
}

export function agentTypeSupportsProprMcp(agentType: unknown): boolean {
  return AGENT_TYPES_SUPPORTING_PROPR_MCP.includes(agentType as typeof AGENT_TYPES_SUPPORTING_PROPR_MCP[number]);
}

/** Only the UI "Run now" (manual) trigger is attended; everything else runs unattended. */
export function isUnattendedTrigger(trigger: AgentRunTrigger): boolean {
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
 * Validate agent definition fields. Returns a user-facing error, or null when
 * the input satisfies the contract. With `partial`, only fields that are
 * present are checked (updates). Agent/model support, including whether the
 * agent type supports propr_mcp, is checked separately against the live
 * agent configuration.
 */
export function validateAgentDefinitionInput(input: unknown, options: { partial?: boolean } = {}): string | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return 'agent definition must be an object';
  const body = input as Record<string, unknown>;
  const partial = options.partial === true;

  if (!partial || has(body, 'name')) {
    if (typeof body.name !== 'string' || body.name.trim().length < 1) return 'name is required';
    if (body.name.length > AGENT_NAME_MAX_LENGTH) return `name must be at most ${AGENT_NAME_MAX_LENGTH} characters`;
  }
  const descriptionError = validateOptionalText(body.description, 'description', AGENT_DESCRIPTION_MAX_LENGTH);
  if (descriptionError) return descriptionError;
  if (!partial || has(body, 'prompt')) {
    if (typeof body.prompt !== 'string' || body.prompt.trim().length < 1) return 'prompt is required';
    if (body.prompt.length > AGENT_PROMPT_MAX_LENGTH) return `prompt must be at most ${AGENT_PROMPT_MAX_LENGTH} characters`;
  }

  if (has(body, 'repositories')) {
    const repositories = body.repositories;
    if (!Array.isArray(repositories)) return 'repositories must be an array';
    if (repositories.length > MAX_AGENT_REPOSITORIES) return `repositories must contain at most ${MAX_AGENT_REPOSITORIES} entries`;
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
      if (!isAgentCapability(capability)) return `capabilities must be one of: ${AGENT_CAPABILITIES.join(', ')}`;
    }
    if (new Set(capabilities).size !== capabilities.length) return 'capabilities must not contain duplicates';
  }

  if (has(body, 'autonomy') && !isAgentAutonomyMode(body.autonomy)) {
    return `autonomy must be one of: ${AGENT_AUTONOMY_MODES.join(', ')}`;
  }

  if (body.schedule != null) {
    const scheduleError = validateAgentSchedule(body.schedule);
    if (scheduleError) return scheduleError;
  }

  if (has(body, 'enabled') && typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
  if (body.agentId != null && (typeof body.agentId !== 'string' || !body.agentId)) return 'agentId must be a non-empty string';
  if (body.model != null && (typeof body.model !== 'string' || !body.model)) return 'model must be a non-empty string';

  if (has(body, 'previousReportCount')) {
    const count = body.previousReportCount;
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > MAX_AGENT_PREVIOUS_REPORTS) {
      return `previousReportCount must be an integer from 0 to ${MAX_AGENT_PREVIOUS_REPORTS}`;
    }
  }

  return null;
}
