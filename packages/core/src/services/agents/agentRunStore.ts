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
 * - acting            → completed | failed | cancelled | awaiting_approval (an unclaimed
 *                       unattended acting step held back by the cost gate)
 */
export const AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunState, readonly AgentRunState[]>> = {
  queued: ['running', 'deferred', 'skipped', 'cancelled', 'failed'],
  deferred: ['queued', 'skipped', 'cancelled'],
  running: ['report_ready', 'failed', 'cancelled'],
  report_ready: ['completed', 'awaiting_approval', 'acting', 'failed'],
  awaiting_approval: ['acting', 'rejected', 'cancelled'],
  acting: ['completed', 'failed', 'cancelled', 'awaiting_approval'],
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
  /** The approver's guidance for the acting step, stored with the approval so a re-dispatch keeps it. */
  operatorNote: string | null;
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
  failure_reason: string | null; approved_by: string | null; operator_note: string | null; deferred_until: number | null; deferrals: number;
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
    operatorNote: row.operator_note ?? null,
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
  /** Why the run was held; recorded when `initialState` is `skipped` or `deferred`. */
  skipReason?: string | null;
  /** False for a deferral that does not count against the deferral limit (a wait for the unattended window). */
  deferralCounted?: boolean;
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
    skip_reason: state === 'skipped' || state === 'deferred' ? input.skipReason ?? null : null,
    failure_reason: null,
    approved_by: null,
    operator_note: null,
    deferred_until: state === 'deferred' ? input.deferredUntil ?? null : null,
    deferrals: state === 'deferred' && input.deferralCounted !== false ? 1 : 0,
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

/**
 * Records a run that was never started, so the history shows why nothing ran
 * (e.g. a scheduled slot whose definition no longer validates). With an
 * idempotency key, a replay returns the run already recorded.
 */
export async function recordSkippedRun(
  input: Omit<CreateAgentRunInput, 'initialState' | 'deferredUntil' | 'skipReason'> & { skipReason: string },
  deps: AgentRunStoreDependencies = {},
): Promise<CreateAgentRunResult> {
  return createAgentRun({ ...input, initialState: 'skipped' }, deps);
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
  operatorNote?: string | null;
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
  if (patch.operatorNote !== undefined) changes.operator_note = patch.operatorNote;
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
  deps: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  return applyAgentRunTransition(id, from, to, patch, deps, {});
}

/**
 * Moves a deferred run out of `deferred`, guarded by the `deferred_until` the
 * caller evaluated as well as the state. A retry acting on an older evaluation
 * then cannot queue or skip a run another retry has since re-deferred. Returns
 * null when the run left `deferred` or its retry time changed.
 */
// eslint-disable-next-line max-params -- the run, the evaluated retry time and the target state with its patch, plus the shared store dependencies
export async function transitionDeferredAgentRun(
  id: string,
  evaluatedDeferredUntil: number,
  to: AgentRunState,
  patch: AgentRunTransitionPatch = {},
  deps: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  return applyAgentRunTransition(id, ['deferred'], to, patch, deps, { deferred_until: evaluatedDeferredUntil });
}

// eslint-disable-next-line max-params -- the transition arguments plus the extra row guard
async function applyAgentRunTransition(
  id: string,
  from: readonly AgentRunState[],
  to: AgentRunState,
  patch: AgentRunTransitionPatch,
  { database = db, now = Date.now }: AgentRunStoreDependencies,
  guard: Record<string, unknown>,
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
  const [updated] = await database(TABLE).where({ ...guard, id }).whereIn('state', [...from]).update(changes)
    .returning('*') as AgentRunRow[];
  return updated ? rowToAgentRun(updated) : null;
}

/**
 * Claims an `acting` run for one action-phase execution by recording its task.
 * The acting state has no separate "started" state, so `action_task_id` is
 * the claim: only the first delivery for a run gets the row back, a later one
 * gets null.
 */
export async function claimAgentRunAction(
  id: string,
  actionTaskId: string,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  const [updated] = await database(TABLE).where({ id, state: 'acting' }).whereNull('action_task_id')
    .update({ action_task_id: actionTaskId, updated_at: now() })
    .returning('*') as AgentRunRow[];
  return updated ? rowToAgentRun(updated) : null;
}

/**
 * Fails an `acting` run whose acting step could not be dispatched, but only
 * while no action job has claimed it. A claimed run is executing (or already
 * finished), so a redundant dispatch error must not overwrite it. Returns the
 * failed run, or null when the run was claimed or left `acting` first.
 */
export async function failUnclaimedAgentRunAction(
  id: string,
  failureReason: string,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  const timestamp = now();
  const [updated] = await database(TABLE).where({ id, state: 'acting' }).whereNull('action_task_id')
    .update({ state: 'failed', failure_reason: failureReason, updated_at: timestamp, finished_at: timestamp })
    .returning('*') as AgentRunRow[];
  return updated ? rowToAgentRun(updated) : null;
}

/**
 * Returns an unattended `acting` run to `awaiting_approval` with `skipReason`,
 * but only while no action job has claimed it and no human approved it: the
 * cost gate held its acting step back before any task or container existed.
 * Returns the waiting run, or null when the run was claimed, approved or left
 * `acting` first.
 */
export async function pauseUnclaimedAgentRunAction(
  id: string,
  skipReason: string,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  const [updated] = await database(TABLE).where({ id, state: 'acting' }).whereNull('action_task_id').whereNull('approved_by')
    .update({ state: 'awaiting_approval', skip_reason: skipReason, updated_at: now() })
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

/** The run a definition already recorded for an idempotency key, if any. */
export async function getAgentRunByIdempotencyKey(
  definitionId: string,
  idempotencyKey: string,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | undefined> {
  const row = await database(TABLE).where({ definition_id: definitionId, idempotency_key: idempotencyKey })
    .first<AgentRunRow | undefined>();
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

/**
 * Queued runs a deferred retry admitted whose report phase may not have been
 * enqueued yet. Moving a deferred run to `queued` keeps its `deferred_until`
 * as the dispatch obligation; `markRetriedAgentRunDispatched` clears it once
 * the job is enqueued. A retry interrupted in between (e.g. the daemon exited)
 * leaves the run here for the consumer to dispatch again.
 */
export async function listUndispatchedRetriedRuns(
  limit: number,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun[]> {
  const rows = await database(TABLE).where({ state: 'queued' }).whereNotNull('deferred_until')
    .orderBy([{ column: 'deferred_until', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(Math.max(Math.trunc(limit), 1)).select<AgentRunRow[]>();
  return rows.map(rowToAgentRun);
}

/**
 * Releases the dispatch obligation of a retried run after its report phase was
 * enqueued. Guarded by the retry time the run was admitted with, so it never
 * clears a later deferral; it applies in any later state because the worker
 * may already have claimed the run.
 */
export async function markRetriedAgentRunDispatched(
  id: string,
  admittedDeferredUntil: number,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<boolean> {
  const updated = await database(TABLE).where({ id, deferred_until: admittedDeferredUntil }).whereNot('state', 'deferred')
    .update({ deferred_until: null, updated_at: now() });
  return Number(updated) > 0;
}

export interface AgentRunDeferral {
  until: number;
  reason: string;
  /** False for a wait that does not count against the deferral limit (the unattended window). */
  counted?: boolean;
}

/**
 * Defers a due deferred run again, counting the deferral unless it is marked
 * uncounted. Guarded by the `deferred_until` the caller evaluated, so two
 * retries of the same due run cannot both count a deferral. Returns null when
 * the run left `deferred` or was already re-deferred.
 */
export async function redeferAgentRun(
  id: string,
  evaluatedDeferredUntil: number,
  { until, reason, counted = true }: AgentRunDeferral,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  const [updated] = await database(TABLE).where({ id, state: 'deferred', deferred_until: evaluatedDeferredUntil })
    .update({ deferred_until: until, skip_reason: reason, deferrals: counted ? database.raw('deferrals + 1') : database.raw('deferrals'), updated_at: now() })
    .returning('*') as AgentRunRow[];
  return updated ? rowToAgentRun(updated) : null;
}

/** States in which a run holds (or is about to hold) a worker and spends tokens. */
export const ACTIVE_AGENT_RUN_STATES: readonly AgentRunState[] = ['queued', 'running', 'acting'];

/** Active runs of every definition whose trigger is not `manual`, for the unattended concurrency cap. */
export async function countActiveUnattendedAgentRuns({ database = db }: AgentRunStoreDependencies = {}): Promise<number> {
  const row = await database(TABLE).whereIn('state', [...ACTIVE_AGENT_RUN_STATES]).whereNot('trigger', 'manual')
    .count<{ count: number | string }[]>({ count: '*' }).first();
  return Number(row?.count ?? 0);
}
