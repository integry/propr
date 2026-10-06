import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  AGENT_REPORT_MAX_CHARS,
  DEFAULT_AGENT_AUTONOMY_MODE,
  isAgentAutonomyMode,
  isAgentRunState,
  isTerminalAgentRunState,
  type AgentAutonomyMode,
  type AgentRunState,
  type AgentRunTrigger,
} from '@propr/shared';
import { db } from '../../db/connection.js';
import type { StoredAgentDefinition } from './agentDefinitionStore.js';

/**
 * Agent run receipts. This is the only module that writes `agent_runs`.
 *
 * The API (trigger, approve/reject, cancel), the daemon (schedule, deferred
 * retry) and the worker (report and acting phases) all move runs concurrently,
 * so every state change is a compare-and-set
 * `UPDATE ... WHERE id = ? AND state IN (from)`: a late worker write cannot
 * resurrect a run that was cancelled in the meantime, it simply gets `null`.
 */

const TABLE = 'agent_runs';
export const DEFAULT_AGENT_RUN_PAGE_SIZE = 50;
export const MAX_AGENT_RUN_PAGE_SIZE = 200;

/**
 * Allowed state transitions. Terminal states (completed, failed, skipped,
 * rejected, cancelled) have no outgoing edges.
 *
 * - queued            → running | deferred | skipped | cancelled | failed
 * - deferred          → queued | skipped | cancelled
 * - running           → report_ready | failed | cancelled
 * - report_ready      → completed (dry_run) | awaiting_approval (preview) | acting (auto) | failed
 * - awaiting_approval → acting (approved) | rejected | cancelled
 * - acting            → completed | failed | cancelled
 */
export const AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunState, readonly AgentRunState[]>> = {
  queued: ['running', 'deferred', 'skipped', 'cancelled', 'failed'],
  deferred: ['queued', 'skipped', 'cancelled'],
  running: ['report_ready', 'failed', 'cancelled'],
  report_ready: ['completed', 'awaiting_approval', 'acting', 'failed'],
  awaiting_approval: ['acting', 'rejected', 'cancelled'],
  acting: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  skipped: [],
  rejected: [],
  cancelled: [],
};

/** States of runs that produced a report, i.e. usable as previous reports. */
export const AGENT_RUN_STATES_WITH_REPORT: readonly AgentRunState[] = ['report_ready', 'awaiting_approval', 'acting', 'completed', 'rejected'];

/** States a run may be created in. */
export type AgentRunInitialState = 'queued' | 'deferred' | 'skipped';

export function isAgentRunTransitionAllowed(from: AgentRunState, to: AgentRunState): boolean {
  return AGENT_RUN_TRANSITIONS[from].includes(to);
}

export interface StoredAgentRun {
  id: string;
  definitionId: string;
  ownerId: string;
  trigger: AgentRunTrigger;
  triggerSource: string | null;
  idempotencyKey: string | null;
  state: AgentRunState;
  /** Autonomy captured at creation so later definition edits do not change it. */
  autonomyMode: AgentAutonomyMode;
  /** Definition as it was when the run was created; null if the stored JSON is unreadable. */
  definitionSnapshot: StoredAgentDefinition | null;
  reportTaskId: string | null;
  actionTaskId: string | null;
  report: string | null;
  reportTruncated: boolean;
  actionSummary: string | null;
  skipReason: string | null;
  failureReason: string | null;
  approvedBy: string | null;
  deferredUntil: number | null;
  deferrals: number;
  createdAt: number;
  startedAt: number | null;
  reportedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface AgentRunRow {
  id: string; definition_id: string; owner_id: string; trigger: string; trigger_source: string | null;
  idempotency_key: string | null; state: string; autonomy_mode: string; definition_snapshot: string;
  report_task_id: string | null; action_task_id: string | null; report: string | null;
  report_truncated: boolean | number; action_summary: string | null; skip_reason: string | null;
  failure_reason: string | null; approved_by: string | null; deferred_until: number | null; deferrals: number;
  created_at: number; started_at: number | null; reported_at: number | null; finished_at: number | null;
  updated_at: number;
}

export interface AgentRunStoreDependencies {
  database?: Knex;
  now?: () => number;
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  return value == null ? null : Number(value);
}

function parseSnapshot(value: string | null | undefined): StoredAgentDefinition | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredAgentDefinition : null;
  } catch {
    return null;
  }
}

/** Pure row mapper. */
export function rowToAgentRun(row: AgentRunRow): StoredAgentRun {
  return {
    id: row.id,
    definitionId: row.definition_id,
    ownerId: row.owner_id,
    trigger: row.trigger as AgentRunTrigger,
    triggerSource: row.trigger_source ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    // An unknown stored state is treated as failed so it is never picked up again.
    state: isAgentRunState(row.state) ? row.state : 'failed',
    autonomyMode: isAgentAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : DEFAULT_AGENT_AUTONOMY_MODE,
    definitionSnapshot: parseSnapshot(row.definition_snapshot),
    reportTaskId: row.report_task_id ?? null,
    actionTaskId: row.action_task_id ?? null,
    report: row.report ?? null,
    reportTruncated: Boolean(row.report_truncated),
    actionSummary: row.action_summary ?? null,
    skipReason: row.skip_reason ?? null,
    failureReason: row.failure_reason ?? null,
    approvedBy: row.approved_by ?? null,
    deferredUntil: toNumberOrNull(row.deferred_until),
    deferrals: Number(row.deferrals ?? 0),
    createdAt: Number(row.created_at),
    startedAt: toNumberOrNull(row.started_at),
    reportedAt: toNumberOrNull(row.reported_at),
    finishedAt: toNumberOrNull(row.finished_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Truncate a report to the stored maximum; the full output stays in the task logs. */
export function truncateAgentReport(report: string): { report: string; truncated: boolean } {
  if (report.length <= AGENT_REPORT_MAX_CHARS) return { report, truncated: false };
  return { report: report.slice(0, AGENT_REPORT_MAX_CHARS), truncated: true };
}

export interface CreateAgentRunInput {
  definition: StoredAgentDefinition;
  trigger: AgentRunTrigger;
  /** Who or what fired the run, e.g. a user id or the scheduler slot. */
  triggerSource?: string | null;
  /** Replays with the same key for the same definition return the existing run. */
  idempotencyKey?: string | null;
  initialState?: AgentRunInitialState;
  /** Required when `initialState` is `deferred`. */
  deferredUntil?: number | null;
  /** Recorded when `initialState` is `skipped`. */
  skipReason?: string | null;
}

export interface CreateAgentRunResult {
  run: StoredAgentRun;
  /** False when an existing run with the same idempotency key was returned. */
  created: boolean;
}

/**
 * Insert a run, ignoring a conflict on `(definition_id, idempotency_key)`.
 * Runs without a key never conflict.
 */
export async function createAgentRun(
  input: CreateAgentRunInput,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<CreateAgentRunResult> {
  const timestamp = now();
  const state = input.initialState ?? 'queued';
  if (state === 'deferred' && input.deferredUntil == null) {
    throw new Error('createAgentRun: deferredUntil is required for a deferred run');
  }
  const idempotencyKey = input.idempotencyKey ?? null;
  const row: AgentRunRow = {
    id: randomUUID(),
    definition_id: input.definition.id,
    owner_id: input.definition.ownerId,
    trigger: input.trigger,
    trigger_source: input.triggerSource ?? null,
    idempotency_key: idempotencyKey,
    state,
    autonomy_mode: input.definition.autonomyMode,
    definition_snapshot: JSON.stringify(input.definition),
    report_task_id: null,
    action_task_id: null,
    report: null,
    report_truncated: false,
    action_summary: null,
    skip_reason: state === 'skipped' ? input.skipReason ?? null : null,
    failure_reason: null,
    approved_by: null,
    deferred_until: state === 'deferred' ? input.deferredUntil ?? null : null,
    deferrals: state === 'deferred' ? 1 : 0,
    created_at: timestamp,
    started_at: null,
    reported_at: null,
    finished_at: isTerminalAgentRunState(state) ? timestamp : null,
    updated_at: timestamp,
  };
  // RETURNING binds the receipt to this insert: a run transitioned by another
  // process right after creation is still reported as it was created.
  const [inserted] = await database(TABLE).insert(row).onConflict(['definition_id', 'idempotency_key']).ignore()
    .returning('*') as AgentRunRow[];
  if (inserted) return { run: rowToAgentRun(inserted), created: true };
  if (idempotencyKey === null) throw new Error('createAgentRun: insert without an idempotency key was ignored');

  const stored = await database(TABLE)
    .where({ definition_id: input.definition.id, idempotency_key: idempotencyKey })
    .first<AgentRunRow | undefined>();
  if (!stored) throw new Error(`createAgentRun: run for idempotency key ${idempotencyKey} disappeared after insert`);
  return { run: rowToAgentRun(stored), created: false };
}

export interface AgentRunTransitionPatch {
  reportTaskId?: string | null;
  actionTaskId?: string | null;
  /** Truncated to `AGENT_REPORT_MAX_CHARS`; `report_truncated` is set accordingly. */
  report?: string | null;
  actionSummary?: string | null;
  skipReason?: string | null;
  failureReason?: string | null;
  approvedBy?: string | null;
  /** Required when moving to `deferred`. */
  deferredUntil?: number | null;
}

function patchToRowChanges(patch: AgentRunTransitionPatch): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (patch.reportTaskId !== undefined) changes.report_task_id = patch.reportTaskId;
  if (patch.actionTaskId !== undefined) changes.action_task_id = patch.actionTaskId;
  if (patch.report !== undefined) {
    const { report, truncated } = patch.report === null ? { report: null, truncated: false } : truncateAgentReport(patch.report);
    changes.report = report;
    changes.report_truncated = truncated;
  }
  if (patch.actionSummary !== undefined) changes.action_summary = patch.actionSummary;
  if (patch.skipReason !== undefined) changes.skip_reason = patch.skipReason;
  if (patch.failureReason !== undefined) changes.failure_reason = patch.failureReason;
  if (patch.approvedBy !== undefined) changes.approved_by = patch.approvedBy;
  if (patch.deferredUntil !== undefined) changes.deferred_until = patch.deferredUntil;
  return changes;
}

/**
 * Guarded state change: moves the run to `to` only if it is currently in one
 * of `from`. Returns the updated run, or null when the run is missing or was
 * no longer in an allowed state (another process got there first).
 *
 * Throws for a `from → to` pair that `AGENT_RUN_TRANSITIONS` does not allow;
 * that is a programming error, not a race.
 */
// eslint-disable-next-line max-params -- id, the from → to pair and its patch, plus the shared store dependencies
export async function transitionAgentRun(
  id: string,
  from: readonly AgentRunState[],
  to: AgentRunState,
  patch: AgentRunTransitionPatch = {},
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  if (from.length === 0) throw new Error('transitionAgentRun: at least one source state is required');
  for (const source of from) {
    if (!isAgentRunTransitionAllowed(source, to)) {
      throw new Error(`transitionAgentRun: illegal agent run transition ${source} → ${to}`);
    }
  }
  if (to === 'deferred' && patch.deferredUntil == null) {
    throw new Error('transitionAgentRun: deferredUntil is required when deferring a run');
  }

  const timestamp = now();
  const changes: Record<string, unknown> = { ...patchToRowChanges(patch), state: to, updated_at: timestamp };
  if (to === 'running') changes.started_at = database.raw('COALESCE(started_at, ?)', [timestamp]);
  if (to === 'report_ready') changes.reported_at = timestamp;
  if (to === 'deferred') changes.deferrals = database.raw('deferrals + 1');
  if (isTerminalAgentRunState(to)) changes.finished_at = timestamp;

  // RETURNING yields the row this update produced; a separate read could see a
  // competing transition that landed after it.
  const [updated] = await database(TABLE).where({ id }).whereIn('state', [...from]).update(changes)
    .returning('*') as AgentRunRow[];
  return updated ? rowToAgentRun(updated) : null;
}

/** Owner-scoped read; another owner's run is indistinguishable from a missing one. */
export async function getAgentRun(
  id: string,
  ownerId: string,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | undefined> {
  const row = await database(TABLE).where({ id, owner_id: ownerId }).first<AgentRunRow | undefined>();
  return row ? rowToAgentRun(row) : undefined;
}

/** Internal read for the worker and daemon; not owner-scoped. */
export async function getAgentRunById(
  id: string,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | undefined> {
  const row = await database(TABLE).where({ id }).first<AgentRunRow | undefined>();
  return row ? rowToAgentRun(row) : undefined;
}

export interface AgentRunPage {
  limit?: number;
  offset?: number;
}

export interface AgentRunList {
  runs: StoredAgentRun[];
  total: number;
  limit: number;
  offset: number;
}

/** A definition's runs for its owner, newest first. */
export async function listAgentRuns(
  definitionId: string,
  ownerId: string,
  page: AgentRunPage = {},
  { database = db }: AgentRunStoreDependencies = {},
): Promise<AgentRunList> {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_AGENT_RUN_PAGE_SIZE), 1), MAX_AGENT_RUN_PAGE_SIZE);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  const scope = { definition_id: definitionId, owner_id: ownerId };
  const [rows, countRow] = await Promise.all([
    database(TABLE).where(scope).orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(limit).offset(offset).select<AgentRunRow[]>(),
    database(TABLE).where(scope).count<{ count: number | string }[]>({ count: '*' }).first(),
  ]);
  return { runs: rows.map(rowToAgentRun), total: Number(countRow?.count ?? 0), limit, offset };
}

/** Deferred runs whose retry time has passed, oldest due first. */
export async function listDueDeferredRuns(
  now: number,
  limit: number,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun[]> {
  const rows = await database(TABLE).where({ state: 'deferred' }).where('deferred_until', '<=', now)
    .orderBy([{ column: 'deferred_until', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(Math.max(Math.trunc(limit), 1)).select<AgentRunRow[]>();
  return rows.map(rowToAgentRun);
}

export interface PreviousAgentReport {
  runId: string;
  reportedAt: number;
  report: string;
}

export interface ListPreviousReportsOptions {
  limit: number;
  /** Only runs created strictly before this time (epoch ms), typically the current run's `createdAt`. */
  beforeCreatedAt?: number;
  /** Run to leave out regardless of timestamps, typically the current run. */
  excludeRunId?: string;
}

/**
 * The newest reports a definition produced, newest first, so a recurring
 * agent can diff against last time. Failed, skipped and cancelled-before-report
 * runs are excluded because they have no report.
 */
export async function listPreviousReports(
  definitionId: string,
  { limit, beforeCreatedAt, excludeRunId }: ListPreviousReportsOptions,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<PreviousAgentReport[]> {
  const boundedLimit = Math.trunc(limit);
  if (!(boundedLimit > 0)) return [];
  const query = database(TABLE).where({ definition_id: definitionId })
    .whereIn('state', [...AGENT_RUN_STATES_WITH_REPORT])
    .whereNotNull('report');
  if (beforeCreatedAt !== undefined) query.where('created_at', '<', beforeCreatedAt);
  if (excludeRunId !== undefined) query.whereNot({ id: excludeRunId });
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(boundedLimit).select<Pick<AgentRunRow, 'id' | 'reported_at' | 'created_at' | 'report'>[]>('id', 'reported_at', 'created_at', 'report');
  return rows.map(row => ({
    runId: row.id,
    reportedAt: Number(row.reported_at ?? row.created_at),
    report: row.report ?? '',
  }));
}
