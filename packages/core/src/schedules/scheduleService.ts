import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { MAX_RUN_COST_CAP_USD } from '../budget/runCostCap.js';
import { CronExpressionError, isValidTimeZone, nextCronRun, parseCronExpression, upcomingCronRuns } from './cron.js';

/** What a schedule submits each time it fires: the shape of a REST task submission. */
export interface ScheduleInstruction {
  text: string;
  agentAlias?: string;
  model?: string;
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
  /** Per-task spend cap in USD; 0 or omitted uses the repository/instance cap. */
  maxCostUsd?: number;
}

export interface TaskScheduleRow {
  id: string;
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  instruction: string;
  enabled: boolean | number;
  owner_user_id: string;
  owner_username: string;
  last_run_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSchedule {
  id: string;
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  instruction: ScheduleInstruction;
  enabled: boolean;
  owner: { userId: string; username: string };
  lastRunAt: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleRunTrigger = 'schedule' | 'manual';
export type ScheduleRunStatus = 'dispatching' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface TaskScheduleRunRow {
  id: number;
  schedule_id: string;
  idempotency_key: string;
  slot: string;
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  reason: string | null;
  submission_id: string | null;
  task_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TaskScheduleRun {
  id: number;
  scheduleId: string;
  slot: string;
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  reason: string | null;
  submissionId: string | null;
  taskId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ScheduleInput {
  name?: string;
  repository: string;
  cron: string;
  timezone: string;
  instruction: ScheduleInstruction;
  enabled?: boolean;
}

export type ScheduleUpdate = Partial<ScheduleInput>;

/** Consecutive failed runs after which a schedule pauses itself. */
export const SCHEDULE_FAILURE_PAUSE_THRESHOLD = 3;
/** A schedule may fire at most this often, so a typo cannot flood a repository with issues. */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 5;
/** A slot is dispatched only if the daemon sees it this soon after it fell due. */
export const DEFAULT_MISSED_SLOT_GRACE_MS = 5 * 60_000;
/** A dispatched run that never produced a task within this long is counted as failed. */
export const DEFAULT_STALE_SCHEDULE_RUN_MS = 24 * 60 * 60_000;

const ULTRAFIX_BOUNDS = [1, 10] as const;
export const ACTIVE_RUN_STATUSES: ScheduleRunStatus[] = ['dispatching', 'dispatched'];

export class ScheduleValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

export class ScheduleNotFoundError extends Error {
  readonly status = 404;
  constructor(id: string) {
    super(`Schedule ${id} was not found`);
    this.name = 'ScheduleNotFoundError';
  }
}

export const iso = (date: Date): string => date.toISOString();

export function scheduleIdempotencyKey(scheduleId: string, slot: string): string {
  return `schedule:${scheduleId}:${slot}`;
}

export function toTaskSchedule(row: TaskScheduleRow): TaskSchedule {
  return {
    id: row.id,
    name: row.name,
    repository: row.repository,
    cron: row.cron,
    timezone: row.timezone,
    instruction: JSON.parse(row.instruction) as ScheduleInstruction,
    enabled: Boolean(row.enabled),
    owner: { userId: row.owner_user_id, username: row.owner_username },
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    consecutiveFailures: row.consecutive_failures,
    pausedReason: row.paused_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTaskScheduleRun(row: TaskScheduleRunRow): TaskScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    slot: row.slot,
    trigger: row.trigger,
    status: row.status,
    reason: row.reason,
    submissionId: row.submission_id,
    taskId: row.task_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

const optionalString = (value: unknown, field: string, max = 256): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new ScheduleValidationError(`${field} must be text of up to ${max} characters`);
  return value.trim() || undefined;
};

const optionalFlag = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ScheduleValidationError(`${field} must be true or false`);
  return value;
};

const optionalBound = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < ULTRAFIX_BOUNDS[0] || value > ULTRAFIX_BOUNDS[1]) {
    throw new ScheduleValidationError(`${field} must be an integer from ${ULTRAFIX_BOUNDS[0]} to ${ULTRAFIX_BOUNDS[1]}`);
  }
  return value;
};

function normalizeUltrafix(raw: Record<string, unknown>): Pick<ScheduleInstruction, 'runUltrafix' | 'ultrafixGoal' | 'ultrafixMaxCycles'> {
  const runUltrafix = optionalFlag(raw.runUltrafix, 'instruction.runUltrafix');
  const ultrafixGoal = optionalBound(raw.ultrafixGoal, 'instruction.ultrafixGoal');
  const ultrafixMaxCycles = optionalBound(raw.ultrafixMaxCycles, 'instruction.ultrafixMaxCycles');
  if (!runUltrafix) {
    if (ultrafixGoal !== undefined || ultrafixMaxCycles !== undefined) {
      throw new ScheduleValidationError('instruction.runUltrafix must be true when ultrafixGoal or ultrafixMaxCycles is set');
    }
    return {};
  }
  return {
    runUltrafix: true,
    ...(ultrafixGoal === undefined ? {} : { ultrafixGoal }),
    ...(ultrafixMaxCycles === undefined ? {} : { ultrafixMaxCycles }),
  };
}

function normalizeCostCap(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_RUN_COST_CAP_USD) {
    throw new ScheduleValidationError(`instruction.maxCostUsd must be a USD amount from 0 to ${MAX_RUN_COST_CAP_USD}`);
  }
  return value || undefined;
}

export function normalizeScheduleInstruction(value: unknown): ScheduleInstruction {
  if (!value || typeof value !== 'object') throw new ScheduleValidationError('instruction is required');
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 50_000) {
    throw new ScheduleValidationError('instruction.text is required (up to 50,000 characters)');
  }
  const agentAlias = optionalString(raw.agentAlias, 'instruction.agentAlias');
  const model = optionalString(raw.model, 'instruction.model');
  const autoMerge = optionalFlag(raw.autoMerge, 'instruction.autoMerge');
  const maxCostUsd = normalizeCostCap(raw.maxCostUsd);
  return {
    text: raw.text,
    ...(agentAlias ? { agentAlias } : {}),
    ...(model ? { model } : {}),
    ...(autoMerge ? { autoMerge: true } : {}),
    ...normalizeUltrafix(raw),
    ...(maxCostUsd ? { maxCostUsd } : {}),
  };
}

/** Rejects unknown zones, unparseable expressions, ones that never fire, and ones that fire too often. */
export function validateScheduleTiming(cron: unknown, timezone: unknown, now: Date = new Date()): { cron: string; timezone: string } {
  if (typeof timezone !== 'string' || !isValidTimeZone(timezone.trim())) {
    throw new ScheduleValidationError('timezone must be an IANA time zone such as Europe/Riga or UTC');
  }
  if (typeof cron !== 'string' || !cron.trim()) throw new ScheduleValidationError('cron is required, for example "0 3 * * *"');
  let source: string;
  try {
    source = parseCronExpression(cron).source;
  } catch (error) {
    if (error instanceof CronExpressionError) throw new ScheduleValidationError(`Invalid cron expression: ${error.message}`);
    throw error;
  }
  const runs = upcomingCronRuns(source, timezone.trim(), now, 12);
  if (runs.length === 0) throw new ScheduleValidationError(`The cron expression "${source}" never fires`);
  for (let index = 1; index < runs.length; index++) {
    if (runs[index].getTime() - runs[index - 1].getTime() < SCHEDULE_MIN_INTERVAL_MINUTES * 60_000) {
      throw new ScheduleValidationError(`A schedule may fire at most once every ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes`);
    }
  }
  return { cron: source, timezone: timezone.trim() };
}

function normalizeRepository(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value.trim())) {
    throw new ScheduleValidationError('repository must be in owner/name format');
  }
  return value.trim().toLowerCase();
}

function normalizeName(value: unknown, instruction: ScheduleInstruction): string {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ScheduleValidationError('name must be text');
  const name = (typeof value === 'string' ? value : '').trim() || instruction.text.trim().split('\n')[0].trim();
  if (!name) throw new ScheduleValidationError('name is required');
  return name.length > 200 ? `${name.slice(0, 197)}...` : name;
}

export function nextRunAfter(cron: string, timezone: string, now: Date): string | null {
  const next = nextCronRun(cron, timezone, now);
  return next ? iso(next) : null;
}

export async function getSchedule(database: Knex, id: string): Promise<TaskSchedule | null> {
  const row = await database<TaskScheduleRow>('task_schedules').where({ id }).first();
  return row ? toTaskSchedule(row) : null;
}

export async function requireSchedule(database: Knex, id: string): Promise<TaskSchedule> {
  const schedule = await getSchedule(database, id);
  if (!schedule) throw new ScheduleNotFoundError(id);
  return schedule;
}

export async function listSchedules(database: Knex, filters: { repository?: string } = {}): Promise<TaskSchedule[]> {
  const query = database<TaskScheduleRow>('task_schedules').orderBy('created_at', 'asc');
  if (filters.repository) query.where({ repository: filters.repository.toLowerCase() });
  return (await query).map(toTaskSchedule);
}

export async function listScheduleRuns(database: Knex, scheduleId: string, limit = 20): Promise<TaskScheduleRun[]> {
  const rows = await database<TaskScheduleRunRow>('task_schedule_runs').where({ schedule_id: scheduleId })
    .orderBy('id', 'desc').limit(Math.max(1, Math.min(limit, 200)));
  return rows.map(toTaskScheduleRun);
}

/** A new schedule's first slot is always after `now`; it never fires for a slot in the past. */
export async function createSchedule(database: Knex, input: ScheduleInput, owner: { userId: string; username: string }, now: Date = new Date()): Promise<TaskSchedule> {
  const instruction = normalizeScheduleInstruction(input.instruction);
  const timing = validateScheduleTiming(input.cron, input.timezone, now);
  const enabled = optionalFlag(input.enabled, 'enabled') ?? true;
  const id = randomUUID();
  await database('task_schedules').insert({
    id,
    name: normalizeName(input.name, instruction),
    repository: normalizeRepository(input.repository),
    cron: timing.cron,
    timezone: timing.timezone,
    instruction: JSON.stringify(instruction),
    enabled,
    owner_user_id: owner.userId,
    owner_username: owner.username,
    next_run_at: nextRunAfter(timing.cron, timing.timezone, now),
    consecutive_failures: 0,
    created_at: iso(now),
    updated_at: iso(now),
  });
  return requireSchedule(database, id);
}

export async function updateSchedule(database: Knex, id: string, update: ScheduleUpdate, now: Date = new Date()): Promise<TaskSchedule> {
  const current = await requireSchedule(database, id);
  const instruction = update.instruction === undefined ? current.instruction : normalizeScheduleInstruction(update.instruction);
  const timing = update.cron === undefined && update.timezone === undefined
    ? { cron: current.cron, timezone: current.timezone }
    : validateScheduleTiming(update.cron ?? current.cron, update.timezone ?? current.timezone, now);
  const enabled = optionalFlag(update.enabled, 'enabled') ?? current.enabled;
  const reenabled = enabled && !current.enabled;
  const retimed = timing.cron !== current.cron || timing.timezone !== current.timezone;
  const changes: Partial<TaskScheduleRow> = {
    name: update.name === undefined ? current.name : normalizeName(update.name, instruction),
    repository: update.repository === undefined ? current.repository : normalizeRepository(update.repository),
    cron: timing.cron,
    timezone: timing.timezone,
    instruction: JSON.stringify(instruction),
    enabled,
    updated_at: iso(now),
  };
  // Re-enabling or re-timing starts from the next future slot: nothing missed while paused is replayed.
  if (reenabled || retimed || !current.nextRunAt) changes.next_run_at = nextRunAfter(timing.cron, timing.timezone, now);
  if (reenabled) Object.assign(changes, { consecutive_failures: 0, paused_reason: null });
  await database('task_schedules').where({ id }).update(changes);
  return requireSchedule(database, id);
}

export async function deleteSchedule(database: Knex, id: string): Promise<boolean> {
  return (await database('task_schedules').where({ id }).delete()) > 0;
}
