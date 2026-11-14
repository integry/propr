import {
  DEFAULT_AUTOMATION_AUTONOMY_MODE,
  DEFAULT_AUTOMATION_CAPABILITIES,
  nextCronOccurrence,
  normalizeAutomationEventTriggers,
  serializeAutomationExtensions,
} from '@propr/shared';
import type { AgentDefinitionRow, CreateAgentDefinitionInput } from './agentDefinitionStore.js';

/** Schedules are evaluated in UTC in v1. */
export const SCHEDULE_TIMEZONE = 'UTC';

export function statusError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Next UTC fire time for a definition, or null when it cannot fire on its own.
 * An unparseable cron is a client error (400).
 */
export function computeAgentDefinitionNextRunAt(
  schedule: { scheduleCron: string | null; scheduleEnabled: boolean; enabled: boolean },
  now: number,
): number | null {
  if (!schedule.enabled || !schedule.scheduleEnabled || !schedule.scheduleCron) return null;
  try {
    return nextCronOccurrence(schedule.scheduleCron, new Date(now)).getTime();
  } catch (error) {
    throw statusError(error instanceof Error ? error.message : 'Invalid schedule', 400);
  }
}

/** Schedule and enablement columns of a new definition, with defaults applied. */
function newScheduleColumns(input: CreateAgentDefinitionInput, timestamp: number) {
  const scheduleCron = input.scheduleCron ?? null;
  const scheduleEnabled = input.scheduleEnabled ?? false;
  const enabled = input.enabled ?? true;
  return {
    schedule_cron: scheduleCron,
    schedule_timezone: SCHEDULE_TIMEZONE,
    schedule_enabled: scheduleEnabled,
    next_run_at: computeAgentDefinitionNextRunAt({ scheduleCron, scheduleEnabled, enabled }, timestamp),
    enabled,
  };
}

/** Content columns of a new definition, with defaults applied and JSON columns serialized. */
function newContentColumns(input: CreateAgentDefinitionInput) {
  return {
    extensions: serializeAutomationExtensions(input.extensions),
    name: input.name,
    description: input.description ?? null,
    repositories: JSON.stringify(input.repositories ?? []),
    prompt: input.prompt,
    attachments: JSON.stringify(input.attachments ?? []),
    agent_alias: input.agentAlias ?? null,
    model_name: input.modelName ?? null,
  };
}

/** Run-behaviour columns of a new definition, with defaults applied and JSON columns serialized. */
function newBehaviourColumns(input: CreateAgentDefinitionInput) {
  return {
    capabilities: JSON.stringify(input.capabilities ?? DEFAULT_AUTOMATION_CAPABILITIES),
    include_previous_reports: input.includePreviousReports ?? true,
    previous_reports_limit: input.previousReportsLimit ?? 1,
    autonomy_mode: input.autonomyMode ?? DEFAULT_AUTOMATION_AUTONOMY_MODE,
    event_triggers: JSON.stringify(normalizeAutomationEventTriggers(input.eventTriggers ?? [])),
    pause_when_unproductive: input.pauseWhenUnproductive ?? false,
  };
}

/** The row `createAgentDefinition` inserts for `input`. */
export function newAgentDefinitionRow(input: CreateAgentDefinitionInput, id: string, timestamp: number): AgentDefinitionRow {
  return {
    id,
    owner_id: input.ownerId,
    ...newContentColumns(input),
    ...newBehaviourColumns(input),
    ...newScheduleColumns(input, timestamp),
    revision: 0, created_at: timestamp, updated_at: timestamp,
  };
}
