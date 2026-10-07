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
const RUNS_TABLE = 'agent_runs';
/** Conditional attachment writes retry this many times when another write keeps landing first. */
const MAX_ATTACHMENT_WRITE_ATTEMPTS = 5;
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
  /** Claimed schedule slot without a run receipt yet; only the scheduler reads it. */
  pending_schedule_slot?: number | string | null;
  /** When a sweep last tried to record the pending slot's run; only the scheduler reads it. */
  pending_schedule_attempted_at?: number | string | null;
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

/** A definition the scheduler should act on, with the slot it claimed but has not recorded yet. */
export interface DueScheduledAgentDefinition {
  definition: StoredAgentDefinition;
  /** A claimed slot (epoch ms) whose run receipt does not exist yet; null when there is none. */
  pendingSlot: number | null;
}

function pendingScheduleSlot(row: AgentDefinitionRow): number | null {
  return row.pending_schedule_slot == null ? null : Number(row.pending_schedule_slot);
}

/**
 * Definitions the scheduler should act on: those with a claimed slot still
 * waiting for its run receipt, least recently attempted first, and those
 * enabled, scheduled and due at `now`, oldest due first. Not owner-scoped;
 * only the daemon calls it.
 *
 * Pending slots and fresh due definitions share the batch: when both kinds
 * are waiting, each gets at least half of it, and either takes the space the
 * other leaves. Pending slots whose trigger keeps failing therefore never fill
 * every batch and starve due definitions, and since each attempt moves a slot
 * behind the others (`admitAgentDefinitionScheduleSlot`), they never starve
 * other pending slots either.
 */
export async function listDueScheduledAgentDefinitions(
  now: number,
  limit: number,
  { database = db }: AgentDefinitionStoreDependencies = {},
): Promise<DueScheduledAgentDefinition[]> {
  const size = Math.max(Math.trunc(limit), 1);
  const pending = await database(TABLE).whereNotNull('pending_schedule_slot')
    .orderByRaw('CASE WHEN pending_schedule_attempted_at IS NULL THEN 0 ELSE 1 END')
    .orderBy([{ column: 'pending_schedule_attempted_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(size).select<AgentDefinitionRow[]>();
  const due = await database(TABLE).whereNull('pending_schedule_slot')
    .where({ schedule_enabled: true, enabled: true }).where('next_run_at', '<=', now)
    .orderBy([{ column: 'next_run_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(size).select<AgentDefinitionRow[]>();
  const pendingCount = Math.min(pending.length, Math.max(Math.ceil(size / 2), size - due.length));
  const rows = [...pending.slice(0, pendingCount), ...due.slice(0, size - pendingCount)];
  return rows.map(row => ({ definition: rowToAgentDefinition(row), pendingSlot: pendingScheduleSlot(row) }));
}

/**
 * Claims one schedule slot by moving `next_run_at` from the value the caller
 * read (`claimedNextRunAt`) to `nextRunAt` and recording `slot` as pending in
 * the same update. Only one of several concurrent sweeps gets the definition
 * back; the others get null and must not fire. A definition with a pending slot cannot be claimed
 * again until `releaseAgentDefinitionScheduleSlot` clears it. The returned
 * definition is the row as of the claim, so a schedule or agent disabled
 * since the sweep read it is never fired. The claim is not a user edit, so
 * `revision` and `updated_at` are left alone.
 */
export async function claimAgentDefinitionScheduleSlot(
  id: string,
  { claimedNextRunAt, nextRunAt, slot }: { claimedNextRunAt: number; nextRunAt: number; slot: number },
  { database = db }: AgentDefinitionStoreDependencies = {},
): Promise<StoredAgentDefinition | null> {
  const [updated] = await database(TABLE)
    .where({ id, next_run_at: claimedNextRunAt, schedule_enabled: true, enabled: true })
    .whereNull('pending_schedule_slot')
    .update({ next_run_at: nextRunAt, pending_schedule_slot: slot })
    .returning('*') as AgentDefinitionRow[];
  return updated ? rowToAgentDefinition(updated) : null;
}

/**
 * Admits a pending slot for one attempt: returns the definition as stored
 * now, so a schedule or agent disabled since the sweep read its batch is
 * seen before the slot starts work, and records the attempt so the slot is
 * retried behind other pending slots. Returns null once the slot is no longer
 * pending (another sweep recorded it, or the schedule was turned off on the
 * system's behalf).
 */
export async function admitAgentDefinitionScheduleSlot(
  id: string,
  slot: number,
  { database = db, now = Date.now }: AgentDefinitionStoreDependencies = {},
): Promise<StoredAgentDefinition | null> {
  const [updated] = await database(TABLE).where({ id, pending_schedule_slot: slot })
    .update({ pending_schedule_attempted_at: now() })
    .returning('*') as AgentDefinitionRow[];
  return updated ? rowToAgentDefinition(updated) : null;
}

/**
 * Clears a pending slot once its run receipt exists. Only clears `slot`, so a
 * slower sweep never releases a slot claimed after it read the row.
 */
export async function releaseAgentDefinitionScheduleSlot(
  id: string,
  slot: number,
  { database = db }: AgentDefinitionStoreDependencies = {},
): Promise<boolean> {
  const updated = await database(TABLE).where({ id, pending_schedule_slot: slot })
    .update({ pending_schedule_slot: null, pending_schedule_attempted_at: null });
  return Number(updated) > 0;
}

/**
 * Turns a definition's schedule off on the system's behalf (e.g. its owner
 * left the instance), dropping any pending slot with it. Counts as an edit, so
 * a stale editor gets a 409 instead of silently re-enabling it. Returns false
 * when the schedule was already off.
 */
export async function disableAgentDefinitionSchedule(
  id: string,
  { database = db, now = Date.now }: AgentDefinitionStoreDependencies = {},
): Promise<boolean> {
  return database.transaction(async trx => {
    await trx(TABLE).where({ id }).whereNotNull('pending_schedule_slot')
      .update({ pending_schedule_slot: null, pending_schedule_attempted_at: null });
    const updated = await trx(TABLE).where({ id, schedule_enabled: true })
      .update({ schedule_enabled: false, next_run_at: null, revision: trx.raw('revision + 1'), updated_at: now() });
    return Number(updated) > 0;
  });
}

export type DeleteAgentDefinitionResult = 'deleted' | 'not_found' | 'run_active';

/**
 * Delete a definition only while it has no run in `runStates`. The run check is
 * part of the DELETE statement, so a run entering one of those states either
 * lands first and blocks the delete, or finds its row already cascaded away.
 */
export async function deleteAgentDefinitionUnlessRunInStates(
  id: string,
  ownerId: string,
  runStates: readonly string[],
  { database = db }: AgentDefinitionStoreDependencies = {},
): Promise<DeleteAgentDefinitionResult> {
  const query = database(TABLE).where({ id, owner_id: ownerId });
  if (runStates.length > 0) {
    query.whereNotExists(database(RUNS_TABLE).select(database.raw('1'))
      .where('definition_id', id).whereIn('state', [...runStates]));
  }
  if (await query.delete() > 0) return 'deleted';
  const remaining = await database(TABLE).where({ id, owner_id: ownerId }).first('id');
  return remaining ? 'run_active' : 'not_found';
}

export interface AgentDefinitionAttachmentsChange {
  definition: StoredAgentDefinition;
  /** The stored list `change` was applied to. */
  previous: Attachment[];
}

/**
 * Atomically derive a definition's attachments from the stored list. `change`
 * receives the current list and returns the new one, or throws to abort (for
 * example over a limit). The write is conditional on the list it was computed
 * from, and is retried against the fresh list when another write landed first,
 * so concurrent additions and removals never discard each other. Like
 * `setAgentDefinitionAttachments`, this does not bump the revision. Returns
 * undefined when the definition does not exist for this owner.
 */
export async function changeAgentDefinitionAttachments(
  id: string,
  ownerId: string,
  change: (current: Attachment[]) => Attachment[],
  { database = db, now = Date.now }: AgentDefinitionStoreDependencies = {},
): Promise<AgentDefinitionAttachmentsChange | undefined> {
  for (let attempt = 0; attempt < MAX_ATTACHMENT_WRITE_ATTEMPTS; attempt += 1) {
    const row = await database(TABLE).where({ id, owner_id: ownerId })
      .first<Pick<AgentDefinitionRow, 'attachments'> | undefined>('attachments');
    if (!row) return undefined;
    const previous = parseJsonArray(row.attachments).filter(isAttachment);
    const next = change(previous);
    // RETURNING yields the row this write produced, not a later competing write.
    const [updated] = await database(TABLE).where({ id, owner_id: ownerId, attachments: row.attachments })
      .update({ attachments: JSON.stringify(next), updated_at: now() })
      .returning('*') as AgentDefinitionRow[];
    if (updated) return { definition: rowToAgentDefinition(updated), previous };
  }
  throw statusError('Agent input files were changed concurrently; retry', 409);
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
