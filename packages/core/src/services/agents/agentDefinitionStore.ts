import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  DEFAULT_AGENT_AUTONOMY_MODE,
  DEFAULT_AGENT_CAPABILITIES,
  isAgentAutonomyMode,
  isAgentCapability,
  nextCronOccurrence,
  type AgentAutonomyMode,
  type AgentCapability,
} from '@propr/shared';
import { db } from '../../db/connection.js';
import type { Attachment } from '../attachmentService.js';

/**
 * Saved agent definitions. Definitions are private to their owner in v1: every
 * read, update and delete is scoped by `owner_id`, and another owner's
 * definition is indistinguishable from a missing one.
 */

const TABLE = 'agent_definitions';
/** Schedules are evaluated in UTC in v1. */
const SCHEDULE_TIMEZONE = 'UTC';
export const DEFAULT_AGENT_DEFINITION_PAGE_SIZE = 50;
export const MAX_AGENT_DEFINITION_PAGE_SIZE = 200;

export interface StoredAgentDefinition {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  repositories: string[];
  prompt: string;
  attachments: Attachment[];
  agentAlias: string | null;
  modelName: string | null;
  capabilities: AgentCapability[];
  includePreviousReports: boolean;
  previousReportsLimit: number;
  scheduleCron: string | null;
  scheduleTimezone: string;
  scheduleEnabled: boolean;
  /** Next UTC fire time (epoch ms); null unless enabled, scheduled and a cron is set. */
  nextRunAt: number | null;
  autonomyMode: AgentAutonomyMode;
  enabled: boolean;
  /** Optimistic concurrency token, incremented on every field update. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentDefinitionRow {
  id: string; owner_id: string; name: string; description: string | null; repositories: string | null;
  prompt: string; attachments: string | null; agent_alias: string | null; model_name: string | null;
  capabilities: string | null; include_previous_reports: boolean | number; previous_reports_limit: number;
  schedule_cron: string | null; schedule_timezone: string | null; schedule_enabled: boolean | number;
  next_run_at: number | null; autonomy_mode: string; enabled: boolean | number; revision: number;
  created_at: number; updated_at: number;
}

export interface CreateAgentDefinitionInput {
  ownerId: string;
  name: string;
  prompt: string;
  description?: string | null;
  repositories?: string[];
  attachments?: Attachment[];
  agentAlias?: string | null;
  modelName?: string | null;
  capabilities?: AgentCapability[];
  includePreviousReports?: boolean;
  previousReportsLimit?: number;
  scheduleCron?: string | null;
  scheduleEnabled?: boolean;
  autonomyMode?: AgentAutonomyMode;
  enabled?: boolean;
}

export type AgentDefinitionPatch = Partial<Omit<CreateAgentDefinitionInput, 'ownerId' | 'attachments'>>;

export interface AgentDefinitionPage {
  limit?: number;
  offset?: number;
}

export interface AgentDefinitionList {
  definitions: StoredAgentDefinition[];
  total: number;
  limit: number;
  offset: number;
}

export interface AgentDefinitionStoreDependencies {
  database?: Knex;
  now?: () => number;
}

function statusError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isAttachment(value: unknown): value is Attachment {
  return value != null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';
}

/** Pure row mapper; corrupt JSON columns fall back to empty arrays so list pages never crash. */
export function rowToAgentDefinition(row: AgentDefinitionRow): StoredAgentDefinition {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description ?? null,
    repositories: parseJsonArray(row.repositories).filter((repository): repository is string => typeof repository === 'string'),
    prompt: row.prompt,
    attachments: parseJsonArray(row.attachments).filter(isAttachment),
    agentAlias: row.agent_alias ?? null,
    modelName: row.model_name ?? null,
    capabilities: parseJsonArray(row.capabilities).filter(isAgentCapability),
    includePreviousReports: Boolean(row.include_previous_reports),
    previousReportsLimit: Number(row.previous_reports_limit),
    scheduleCron: row.schedule_cron ?? null,
    scheduleTimezone: row.schedule_timezone || SCHEDULE_TIMEZONE,
    scheduleEnabled: Boolean(row.schedule_enabled),
    nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
    autonomyMode: isAgentAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : DEFAULT_AGENT_AUTONOMY_MODE,
    enabled: Boolean(row.enabled),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
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

export async function createAgentDefinition(
  input: CreateAgentDefinitionInput,
  { database = db, now = Date.now }: AgentDefinitionStoreDependencies = {},
): Promise<StoredAgentDefinition> {
  const timestamp = now();
  const scheduleCron = input.scheduleCron ?? null;
  const scheduleEnabled = input.scheduleEnabled ?? false;
  const enabled = input.enabled ?? true;
  const row: AgentDefinitionRow = {
    id: randomUUID(),
    owner_id: input.ownerId,
    name: input.name,
    description: input.description ?? null,
    repositories: JSON.stringify(input.repositories ?? []),
    prompt: input.prompt,
    attachments: JSON.stringify(input.attachments ?? []),
    agent_alias: input.agentAlias ?? null,
    model_name: input.modelName ?? null,
    capabilities: JSON.stringify(input.capabilities ?? DEFAULT_AGENT_CAPABILITIES),
    include_previous_reports: input.includePreviousReports ?? true,
    previous_reports_limit: input.previousReportsLimit ?? 1,
    schedule_cron: scheduleCron,
    schedule_timezone: SCHEDULE_TIMEZONE,
    schedule_enabled: scheduleEnabled,
    next_run_at: computeAgentDefinitionNextRunAt({ scheduleCron, scheduleEnabled, enabled }, timestamp),
    autonomy_mode: input.autonomyMode ?? DEFAULT_AGENT_AUTONOMY_MODE,
    enabled,
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await database(TABLE).insert(row);
  return rowToAgentDefinition(row);
}

export async function getAgentDefinition(
  id: string,
  ownerId: string,
  { database = db }: AgentDefinitionStoreDependencies = {},
): Promise<StoredAgentDefinition | undefined> {
  const row = await database(TABLE).where({ id, owner_id: ownerId }).first<AgentDefinitionRow | undefined>();
  return row ? rowToAgentDefinition(row) : undefined;
}

export async function listAgentDefinitions(
  ownerId: string,
  page: AgentDefinitionPage = {},
  { database = db }: AgentDefinitionStoreDependencies = {},
): Promise<AgentDefinitionList> {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_AGENT_DEFINITION_PAGE_SIZE), 1), MAX_AGENT_DEFINITION_PAGE_SIZE);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  const [rows, countRow] = await Promise.all([
    database(TABLE).where({ owner_id: ownerId }).orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'asc' }])
      .limit(limit).offset(offset).select<AgentDefinitionRow[]>(),
    database(TABLE).where({ owner_id: ownerId }).count<{ count: number | string }[]>({ count: '*' }).first(),
  ]);
  return { definitions: rows.map(rowToAgentDefinition), total: Number(countRow?.count ?? 0), limit, offset };
}

export interface UpdateAgentDefinitionOptions extends AgentDefinitionStoreDependencies {
  /** When set, the update fails with a 409 unless the stored revision matches. */
  expectedRevision?: number;
}

/** Row columns for the non-schedule fields present in a patch. */
function patchToRowChanges(patch: AgentDefinitionPatch): Partial<AgentDefinitionRow> {
  const changes: Partial<AgentDefinitionRow> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.description !== undefined) changes.description = patch.description;
  if (patch.prompt !== undefined) changes.prompt = patch.prompt;
  if (patch.repositories !== undefined) changes.repositories = JSON.stringify(patch.repositories);
  if (patch.agentAlias !== undefined) changes.agent_alias = patch.agentAlias;
  if (patch.modelName !== undefined) changes.model_name = patch.modelName;
  if (patch.capabilities !== undefined) changes.capabilities = JSON.stringify(patch.capabilities);
  if (patch.includePreviousReports !== undefined) changes.include_previous_reports = patch.includePreviousReports;
  if (patch.previousReportsLimit !== undefined) changes.previous_reports_limit = patch.previousReportsLimit;
  if (patch.autonomyMode !== undefined) changes.autonomy_mode = patch.autonomyMode;
  return changes;
}

/** Schedule columns to write when the patch changes the schedule or enablement; empty otherwise. */
function patchToScheduleChanges(
  patch: AgentDefinitionPatch,
  current: StoredAgentDefinition,
  timestamp: number,
): Partial<AgentDefinitionRow> {
  const schedule = {
    scheduleCron: patch.scheduleCron !== undefined ? patch.scheduleCron : current.scheduleCron,
    scheduleEnabled: patch.scheduleEnabled ?? current.scheduleEnabled,
    enabled: patch.enabled ?? current.enabled,
  };
  if (schedule.scheduleCron === current.scheduleCron
    && schedule.scheduleEnabled === current.scheduleEnabled
    && schedule.enabled === current.enabled) {
    return {};
  }
  return {
    schedule_cron: schedule.scheduleCron,
    schedule_enabled: schedule.scheduleEnabled,
    enabled: schedule.enabled,
    next_run_at: computeAgentDefinitionNextRunAt(schedule, timestamp),
  };
}

/**
 * Apply a partial update. With `expectedRevision`, a stale revision throws a
 * 409; the write itself is also conditional on the revision read, so two
 * concurrent updates cannot both succeed. `next_run_at` is recomputed whenever
 * the schedule or enablement changes. Returns undefined when the definition
 * does not exist for this owner.
 */
export async function updateAgentDefinition(
  id: string,
  ownerId: string,
  patch: AgentDefinitionPatch,
  { expectedRevision, database = db, now = Date.now }: UpdateAgentDefinitionOptions = {},
): Promise<StoredAgentDefinition | undefined> {
  const row = await database(TABLE).where({ id, owner_id: ownerId }).first<AgentDefinitionRow | undefined>();
  if (!row) return undefined;
  const current = rowToAgentDefinition(row);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw statusError(`Agent definition was changed (revision ${current.revision}, expected ${expectedRevision}); reload and retry`, 409);
  }

  const timestamp = now();
  const changes = { ...patchToRowChanges(patch), ...patchToScheduleChanges(patch, current, timestamp) };
  const updated = await database(TABLE).where({ id, owner_id: ownerId, revision: current.revision })
    .update({ ...changes, revision: current.revision + 1, updated_at: timestamp });
  if (updated === 0) throw statusError('Agent definition was changed concurrently; reload and retry', 409);
  return getAgentDefinition(id, ownerId, { database });
}

/** Delete a definition; its runs are removed by the foreign key cascade. */
export async function deleteAgentDefinition(
  id: string,
  ownerId: string,
  { database = db }: AgentDefinitionStoreDependencies = {},
): Promise<boolean> {
  const deleted = await database(TABLE).where({ id, owner_id: ownerId }).delete();
  return deleted > 0;
}

/**
 * Replace a definition's attachments. Attachments are uploaded separately from
 * field edits, so this does not bump the revision and cannot invalidate an
 * in-flight edit. Returns undefined when the definition does not exist for
 * this owner.
 */
export async function setAgentDefinitionAttachments(
  id: string,
  ownerId: string,
  attachments: Attachment[],
  { database = db, now = Date.now }: AgentDefinitionStoreDependencies = {},
): Promise<StoredAgentDefinition | undefined> {
  const updated = await database(TABLE).where({ id, owner_id: ownerId })
    .update({ attachments: JSON.stringify(attachments), updated_at: now() });
  if (updated === 0) return undefined;
  return getAgentDefinition(id, ownerId, { database });
}
