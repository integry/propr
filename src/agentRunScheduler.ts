import type { Knex } from 'knex';
import {
    getGithubUserWhitelist,
    isGithubUserWhitelisted,
    nextCronOccurrence,
    parseCronExpression,
    isAgentRunState,
    isTerminalAgentRunState,
    type AgentRunState,
    type ParsedCronExpression,
} from '@propr/shared';
import {
    AgentRunTriggerError,
    admitAgentDefinitionScheduleSlot,
    claimAgentDefinitionScheduleSlot,
    createAgentRunCostGate,
    db,
    disableAgentDefinitionSchedule,
    enqueueAgentRunPhase,
    getAgentRunByIdempotencyKey,
    listDueScheduledAgentDefinitions,
    logger,
    recordSkippedRun,
    releaseAgentDefinitionScheduleSlot,
    rowToAgentRun,
    retryDueDeferredAgentRuns,
    transitionAgentRun,
    triggerAgentRun,
    type AgentRunEnqueue,
    type AgentRunGate,
    type AgentRunRow,
    type DeferredAgentRunRetryResult,
    type DueScheduledAgentDefinition,
    type StoredAgentDefinition,
    type StoredAgentRun,
    type TriggerAgentRunInput,
    type TriggerAgentRunResult,
} from '@propr/core';
import { revokeAgentRunMcpGrant } from './jobs/agentRuns/mcpGrantClient.js';
import type { AgentRunPhase } from './jobs/agentRuns/toolPolicy.js';

/**
 * The daemon's agent run sweeps. The schedule is another daemon sweep, not a
 * separate service, and every scheduled run goes through `triggerAgentRun`
 * with the cost gate.
 *
 * - schedule: fires due definitions exactly once per slot. A compare-and-set
 *   on `next_run_at` lets one sweep claim a slot and records it as pending in
 *   the same update; the pending slot is cleared only once its run receipt
 *   exists, so a sweep that stops in between is resumed by the next one. The
 *   run's idempotency key `schedule:<slot ISO>` makes a replay of the same slot
 *   return the same run. Missed slots coalesce into one run for the latest
 *   due slot.
 * - deferred retry: re-evaluates deferred runs through the cost gate.
 * - stuck runs: fails `running`/`acting` runs whose task ended long ago, i.e.
 *   the worker stopped before recording the result.
 * - grant cleanup (slower cadence): revokes run-scoped MCP grants left behind
 *   by terminal runs or past their expiry, a backstop for crashed workers.
 *
 * Stuck-run recovery and grant cleanup page through every candidate on each
 * pass, so records that stay ineligible never hide later eligible ones. The
 * schedule batch splits between pending slots and fresh due definitions and
 * rotates pending slots by last attempt, so slots that keep failing never
 * starve other definitions.
 */

export const AGENT_SCHEDULE_SWEEP_BATCH_SIZE = 50;
export const DEFAULT_AGENT_RUN_SWEEP_INTERVAL_MS = 60_000;
export const AGENT_RUN_GRANT_CLEANUP_INTERVAL_MS = 10 * 60_000;
/** How long a run's task must have been terminal before the run is failed. */
export const AGENT_RUN_STUCK_GRACE_MS = 10 * 60_000;
export const AGENT_RUN_STUCK_FAILURE_REASON = 'The worker stopped before recording the result.';

const AGENT_RUN_GRANT_RECORD_KIND = 'agent_run_grant';
const GRANT_CLEANUP_BATCH_SIZE = 200;
const STUCK_RUN_BATCH_SIZE = 100;
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);
const MINUTE_MS = 60_000;

export interface AgentRunSweepDependencies {
    database?: Knex;
    now?: () => number;
    /** Fires a run; defaults to `triggerAgentRun` with this sweep's database, clock and queue. */
    trigger?: (input: TriggerAgentRunInput) => Promise<TriggerAgentRunResult>;
    enqueue?: AgentRunEnqueue;
    gate?: AgentRunGate;
    /** Whether the definition owner may still use the instance. */
    isMember?: (ownerId: string) => Promise<boolean>;
    batchSize?: number;
}

export interface AgentScheduleSweepResult {
    /** Runs created for a slot, whatever state the gate left them in. */
    created: number;
    /** Slots whose run already existed (a replay of the same slot). */
    existing: number;
    /** Slots recorded as `skipped` because the definition no longer validates or was disabled after the claim. */
    invalid: number;
    /** Definitions whose schedule was turned off. */
    disabled: number;
    /** Slots another sweep claimed or recorded first. */
    lost: number;
    failed: number;
}

type ScheduleOutcome = Exclude<keyof AgentScheduleSweepResult, 'failed'> | null;

function bootstrapAdminUsernames(environment: NodeJS.ProcessEnv = process.env): string[] {
    return (environment.PROPR_ADMIN_USERS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * Whether an agent owner is still an instance member. Mirrors the API's
 * whitelist check plus `resolveInstanceAuthorization`, which the daemon cannot
 * import: the owner must pass the GitHub user whitelist when one is
 * configured, and is then a member through an explicit `instance_members` row,
 * as a bootstrap administrator (`PROPR_ADMIN_USERS`), or implicitly as a user
 * who signed in (a stored GitHub user grant). A failed lookup throws, so the
 * sweep keeps the slot pending and retries instead of treating it as lost
 * membership.
 */
export async function isAgentOwnerInstanceMember(ownerId: string, database: Knex = db): Promise<boolean> {
    const member = await database('instance_members').where({ github_user_id: ownerId })
        .first<{ github_username?: string } | undefined>('github_username');
    const grant = await database('github_user_grants').where({ github_user_id: ownerId })
        .first<{ github_username?: string } | undefined>('github_username');
    const username = grant?.github_username || member?.github_username || null;
    if (getGithubUserWhitelist().length > 0 && !isGithubUserWhitelisted(username)) return false;
    if (member || grant) return true;
    return username !== null && bootstrapAdminUsernames().includes(username.toLowerCase());
}

/**
 * The latest slot at or before `now`. The claimed slot is due, so the result
 * is never earlier than it. Binary-searches the last minute whose following
 * occurrence is still due, so a long downtime costs a few dozen cron
 * evaluations instead of one per missed slot.
 */
export function latestDueSlot(cron: ParsedCronExpression, claimedSlot: number, now: number): number {
    const following = (time: number) => nextCronOccurrence(cron, new Date(time)).getTime();
    if (following(claimedSlot) > now) return claimedSlot;
    // Invariant: the occurrence after minute `low` is due, the one after `high` is not.
    let low = Math.floor(claimedSlot / MINUTE_MS);
    let high = Math.floor(now / MINUTE_MS);
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (following(middle * MINUTE_MS) <= now) low = middle;
        else high = middle;
    }
    return following(low * MINUTE_MS);
}

interface ScheduleContext {
    now: number;
    database?: Knex;
    trigger: NonNullable<AgentRunSweepDependencies['trigger']>;
    gate: AgentRunGate;
    isMember: NonNullable<AgentRunSweepDependencies['isMember']>;
    /** Enqueues the report phase of a `queued` receipt. */
    dispatch: (run: StoredAgentRun) => Promise<unknown>;
    clock: () => number;
}

async function disableSchedule(definition: StoredAgentDefinition, reason: string, context: ScheduleContext): Promise<ScheduleOutcome> {
    const disabled = await disableAgentDefinitionSchedule(definition.id, { database: context.database, now: context.clock });
    logger.warn({ definitionId: definition.id, ownerId: definition.ownerId, decision: 'schedule_disabled', reason },
        'Disabled agent schedule');
    return disabled ? 'disabled' : null;
}

/**
 * Claims the latest due slot, recording it as pending in the same update.
 * Returns the claimed definition and slot, or the outcome when nothing is claimed.
 */
async function claimDueSlot(
    due: StoredAgentDefinition,
    context: ScheduleContext,
): Promise<{ definition: StoredAgentDefinition; slot: number } | { outcome: ScheduleOutcome }> {
    const claimedSlot = due.nextRunAt!;
    let next: number;
    let slot: number;
    try {
        const cron = parseCronExpression(due.scheduleCron ?? '');
        next = nextCronOccurrence(cron, new Date(context.now)).getTime();
        slot = latestDueSlot(cron, claimedSlot, context.now);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { outcome: await disableSchedule(due, `The schedule cannot be evaluated: ${message}`, context) };
    }

    // Only one sweep moves next_run_at off the value it read; the others stop here.
    const definition = await claimAgentDefinitionScheduleSlot(due.id,
        { claimedNextRunAt: claimedSlot, nextRunAt: next, slot }, { database: context.database });
    return definition ? { definition, slot } : { outcome: 'lost' };
}

/**
 * Moves a receipt that is still `queued` to `skipped`, so it is never
 * dispatched. A run the worker already advanced is left as it is. Returns the
 * receipt's current state.
 */
async function skipQueuedReceipt(run: StoredAgentRun, skipReason: string, context: ScheduleContext): Promise<StoredAgentRun> {
    if (run.state !== 'queued') return run;
    const storeDeps = { database: context.database, now: context.clock };
    const skipped = await transitionAgentRun(run.id, ['queued'], 'skipped', { skipReason }, storeDeps);
    return skipped ?? await getAgentRunByIdempotencyKey(run.definitionId, run.idempotencyKey!, storeDeps) ?? run;
}

/**
 * A `skipped` receipt for the slot. A replay returns the receipt already
 * recorded, moved to `skipped` if it was still `queued`: the slot starts no new work.
 */
async function recordSkippedSlot(
    definition: StoredAgentDefinition,
    slot: { triggerSource: string; idempotencyKey: string },
    skipReason: string,
    context: ScheduleContext,
): Promise<{ run: StoredAgentRun; created: boolean }> {
    const { run, created } = await recordSkippedRun({ definition, trigger: 'schedule', ...slot, skipReason }, { database: context.database, now: context.clock });
    return { run: created ? run : await skipQueuedReceipt(run, skipReason, context), created };
}

/**
 * Records the run for `slot`, which this or an earlier sweep claimed and left
 * pending. The pending slot is the slot's dispatch obligation: it is released
 * only once the receipt exists and no longer needs dispatching, so a sweep
 * that stopped between creating a `queued` receipt and enqueueing it is
 * completed by the next one.
 */
async function fireClaimedSlot(definition: StoredAgentDefinition, slot: number, context: ScheduleContext): Promise<ScheduleOutcome> {
    const slotIso = new Date(slot).toISOString();
    const slotKeys = { triggerSource: `schedule:${definition.scheduleCron}`, idempotencyKey: `schedule:${slotIso}` };

    // `redispatch`: the receipt may be `queued` without this call having enqueued it.
    let receipt: { run: StoredAgentRun; redispatch: boolean };
    let outcome: ScheduleOutcome;
    // The slot starts no new work, including a receipt an earlier sweep
    // accepted but never dispatched (it would replay the enabled snapshot).
    const skipSlot = async (reason: string, logReason: string): Promise<[typeof receipt, ScheduleOutcome]> => {
        const { run, created } = await recordSkippedSlot(definition, slotKeys, `The scheduled run was skipped: ${reason}`, context);
        logger.info({ definitionId: definition.id, slot: slotIso, runId: run.id, decision: created ? 'skipped' : 'existing', reason: logReason },
            'Scheduled agent run');
        return [{ run, redispatch: false }, created ? 'invalid' : 'existing'];
    };
    if (!definition.scheduleEnabled) {
        // The schedule was turned off after the claim.
        [receipt, outcome] = await skipSlot('the schedule was turned off', 'schedule_disabled');
    } else if (!await context.isMember(definition.ownerId)) {
        // An offboarded owner's agent must stop running. A receipt an earlier
        // sweep accepted but may not have dispatched is skipped first, since
        // disabling drops the pending slot.
        const existing = await getAgentRunByIdempotencyKey(definition.id, slotKeys.idempotencyKey, { database: context.database });
        if (existing) await skipQueuedReceipt(existing, 'The scheduled run was skipped: the owner is no longer an instance member', context);
        return disableSchedule(definition, 'The owner is no longer an instance member', context);
    } else if (!definition.enabled) {
        // The agent was disabled after the claim. Checked here because the
        // trigger returns a replayed receipt before it checks enablement.
        [receipt, outcome] = await skipSlot('Agent is disabled', 'agent_disabled');
    } else {
        try {
            const { run, created, enqueued } = await context.trigger({ definition, trigger: 'schedule', ...slotKeys, gate: context.gate });
            logger.info({ definitionId: definition.id, slot: slotIso, runId: run.id, decision: created ? run.state : 'existing' },
                'Scheduled agent run');
            receipt = { run, redispatch: !enqueued };
            outcome = created ? 'created' : 'existing';
        } catch (error) {
            if (!(error instanceof AgentRunTriggerError) || (error.code !== 'AGENT_INVALID' && error.code !== 'AGENT_DISABLED')) throw error;
            // The history shows why the slot did not run.
            [receipt, outcome] = await skipSlot(error.message, error.message);
        }
    }

    // A replayed `queued` receipt may never have been enqueued (the sweep that
    // created it stopped first). The job id is deterministic and the worker
    // skips a run that is no longer `queued`, so dispatching again is safe. A
    // failed dispatch throws and leaves the slot pending for the next sweep.
    if (receipt.run.state === 'queued' && receipt.redispatch) {
        await context.dispatch(receipt.run);
        logger.info({ definitionId: definition.id, slot: slotIso, runId: receipt.run.id, decision: 'redispatched' },
            'Scheduled agent run');
    }
    await releaseAgentDefinitionScheduleSlot(definition.id, slot, { database: context.database });
    return outcome;
}

/**
 * Resumes a pending slot, or claims the latest due one and fires it. A pending
 * slot blocks new claims, so a sweep that resumes one leaves the next due slot
 * to the following sweep. Either way the slot is admitted against the stored
 * definition, not the batch snapshot: a schedule or agent disabled while
 * earlier definitions in the batch were processed records a skipped receipt
 * instead of starting work.
 */
async function fireDueDefinition({ definition, pendingSlot }: DueScheduledAgentDefinition, context: ScheduleContext): Promise<ScheduleOutcome> {
    let slot = pendingSlot;
    if (slot === null) {
        const claim = await claimDueSlot(definition, context);
        if ('outcome' in claim) return claim.outcome;
        slot = claim.slot;
    }
    const admitted = await admitAgentDefinitionScheduleSlot(definition.id, slot, { database: context.database, now: context.clock });
    // Another sweep already recorded the slot, or the schedule was turned off on the system's behalf.
    if (!admitted) return 'lost';
    return fireClaimedSlot(admitted, slot, context);
}

/**
 * Fires every due scheduled definition once (up to the batch size). Each
 * definition is handled on its own, so one bad definition never stops the sweep.
 */
export async function runAgentScheduleSweep(deps: AgentRunSweepDependencies = {}): Promise<AgentScheduleSweepResult> {
    const {
        database,
        now: clock = Date.now,
        enqueue,
        gate = createAgentRunCostGate({ now: clock }),
        batchSize = AGENT_SCHEDULE_SWEEP_BATCH_SIZE,
        isMember = ownerId => isAgentOwnerInstanceMember(ownerId, database),
        trigger = input => triggerAgentRun(input, { database, now: clock, enqueue }),
    } = deps;
    const now = clock();
    const result: AgentScheduleSweepResult = { created: 0, existing: 0, invalid: 0, disabled: 0, lost: 0, failed: 0 };
    const due = await listDueScheduledAgentDefinitions(now, batchSize, { database });
    const dispatch = (run: StoredAgentRun) => enqueueAgentRunPhase(run, 'report', { enqueue });
    const context: ScheduleContext = { now, database, trigger, gate, isMember, dispatch, clock };
    for (const entry of due) {
        try {
            const outcome = await fireDueDefinition(entry, context);
            if (outcome) result[outcome] += 1;
        } catch (error) {
            result.failed += 1;
            logger.error({ definitionId: entry.definition.id, slot: entry.pendingSlot ?? entry.definition.nextRunAt, err: error },
                'Could not fire scheduled agent run; a claimed slot is resumed on the next sweep');
        }
    }
    if (due.length > 0) logger.info({ due: due.length, ...result }, 'Agent schedule sweep finished');
    return result;
}

/** Re-evaluates due deferred runs through the cost gate (see `retryDueDeferredAgentRuns`). */
export async function runDeferredAgentRunRetrySweep(deps: AgentRunSweepDependencies = {}): Promise<DeferredAgentRunRetryResult> {
    const { database, now, enqueue, gate, batchSize } = deps;
    return retryDueDeferredAgentRuns({ database, now, enqueue, gate, batchSize });
}

function toEpochMs(value: unknown): number | null {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || !value) return null;
    if (/^\d+$/.test(value)) return Number(value);
    // SQLite CURRENT_TIMESTAMP is UTC without a zone designator.
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? null : parsed;
}

/** One page of runs in any of `states`, ordered by id and starting after `afterId`. */
async function listAgentRunsInStates(states: readonly AgentRunState[], limit: number, afterId: string | null, database: Knex): Promise<StoredAgentRun[]> {
    const query = database('agent_runs').whereIn('state', [...states]);
    if (afterId !== null) query.where('id', '>', afterId);
    const rows = await query.orderBy('id', 'asc').limit(limit).select<AgentRunRow[]>();
    return rows.map(rowToAgentRun);
}

/** The run states of `ids`; ids without a run are absent from the map. */
async function getAgentRunStates(ids: readonly string[], database: Knex): Promise<Map<string, AgentRunState>> {
    const rows = await database('agent_runs').whereIn('id', [...new Set(ids)]).select<Pick<AgentRunRow, 'id' | 'state'>[]>('id', 'state');
    return new Map(rows.map(row => [row.id, isAgentRunState(row.state) ? row.state : 'failed']));
}

/** The task a `running` or `acting` run is waiting on, if it has one. */
function activeTaskId(run: StoredAgentRun): string | null {
    if (run.state === 'running') return run.reportTaskId;
    if (run.state === 'acting') return run.actionTaskId;
    return null;
}

/**
 * Fails `running`/`acting` runs whose task has been terminal in `task_history`
 * for longer than the grace period: the worker stopped before recording the
 * result. Aligns agent receipts with the task-state reconciler. An acting run
 * no job has claimed yet has no task and is left alone.
 */
export async function recoverStuckAgentRuns(deps: Pick<AgentRunSweepDependencies, 'database' | 'now'> = {}): Promise<number> {
    const { database = db, now = Date.now } = deps;
    const cutoff = now() - AGENT_RUN_STUCK_GRACE_MS;
    let failed = 0;
    // Page by id through every candidate: runs whose task is still live stay
    // in place and must not hide stuck runs after them.
    let afterId: string | null = null;
    for (;;) {
        const page = await listAgentRunsInStates(['running', 'acting'], STUCK_RUN_BATCH_SIZE, afterId, database);
        failed += await failStuckRuns(page.filter(run => activeTaskId(run) !== null), cutoff, { database, now });
        if (page.length < STUCK_RUN_BATCH_SIZE) return failed;
        afterId = page[page.length - 1].id;
    }
}

async function failStuckRuns(runs: StoredAgentRun[], cutoff: number, { database, now }: { database: Knex; now: () => number }): Promise<number> {
    if (runs.length === 0) return 0;
    const taskIds = [...new Set(runs.map(run => activeTaskId(run)!))];
    const history = await database('task_history').whereIn('task_id', taskIds)
        .orderBy([{ column: 'task_id', order: 'asc' }, { column: 'history_id', order: 'desc' }])
        .select<{ task_id: string; state: string; timestamp: unknown }[]>('task_id', 'state', 'timestamp');
    const latest = new Map<string, { state: string; at: number | null }>();
    for (const row of history) {
        if (!latest.has(row.task_id)) latest.set(row.task_id, { state: row.state, at: toEpochMs(row.timestamp) });
    }

    let failed = 0;
    for (const run of runs) {
        const taskId = activeTaskId(run)!;
        const task = latest.get(taskId);
        if (!task || !TERMINAL_TASK_STATES.has(task.state) || task.at === null || task.at > cutoff) continue;
        try {
            const updated = await transitionAgentRun(run.id, [run.state], 'failed',
                { failureReason: AGENT_RUN_STUCK_FAILURE_REASON }, { database, now });
            if (!updated) continue;
            failed += 1;
            logger.warn({ runId: run.id, definitionId: run.definitionId, taskId, taskState: task.state, previousState: run.state, decision: 'failed' },
                'Failed agent run whose worker stopped before recording the result');
        } catch (error) {
            logger.error({ runId: run.id, err: error }, 'Could not fail a stuck agent run');
        }
    }
    return failed;
}

export interface AgentRunGrantCleanupDependencies {
    database?: Knex;
    now?: () => number;
    /**
     * Revokes one run phase's grant through the API's internal route. With
     * `expiredBy`, the API revokes only a grant that expired by then, so a
     * replacement issued after the record was read is left alone.
     */
    revoke?: (runId: string, phase: AgentRunPhase, fence: { expiredBy?: number }) => Promise<void>;
}

function parseGrantRecordId(id: string): { runId: string; phase: AgentRunPhase } | null {
    const separator = id.lastIndexOf(':');
    if (separator <= 0) return null;
    const phase = id.slice(separator + 1);
    if (phase !== 'report' && phase !== 'action') return null;
    return { runId: id.slice(0, separator), phase };
}

/**
 * Revokes run-scoped MCP grants (`mcp_records` kind `agent_run_grant`) whose
 * run is terminal or gone, or whose record expired. The worker revokes a
 * grant when its phase ends; this is the backstop when it crashed first.
 */
export async function cleanupAgentRunGrants(deps: AgentRunGrantCleanupDependencies = {}): Promise<number> {
    const {
        database = db,
        now = Date.now,
        revoke = (runId, phase, { expiredBy }) => revokeAgentRunMcpGrant(runId, { phase, expiredBy }),
    } = deps;
    const timestamp = now();
    let revoked = 0;
    // Page by id through every grant record: live grants and revocations that
    // keep failing stay in place and must not hide grants after them.
    let afterId: string | null = null;
    for (;;) {
        const query = database('mcp_records').where({ kind: AGENT_RUN_GRANT_RECORD_KIND });
        if (afterId !== null) query.where('id', '>', afterId);
        const records = await query.orderBy('id', 'asc').limit(GRANT_CLEANUP_BATCH_SIZE)
            .select<{ id: string; expires_at: number | string | null }[]>('id', 'expires_at');
        revoked += await revokeLeftoverGrants(records, timestamp, database, revoke);
        if (records.length < GRANT_CLEANUP_BATCH_SIZE) return revoked;
        afterId = records[records.length - 1].id;
    }
}

async function revokeLeftoverGrants(
    records: { id: string; expires_at: number | string | null }[],
    timestamp: number,
    database: Knex,
    revoke: NonNullable<AgentRunGrantCleanupDependencies['revoke']>,
): Promise<number> {
    const grants = records.flatMap(record => {
        const parsed = parseGrantRecordId(record.id);
        return parsed ? [{ ...parsed, expiresAt: record.expires_at == null ? null : Number(record.expires_at) }] : [];
    });
    if (grants.length === 0) return 0;

    const states = await getAgentRunStates(grants.map(grant => grant.runId), database);
    let revoked = 0;
    for (const grant of grants) {
        const state = states.get(grant.runId);
        const expired = grant.expiresAt !== null && grant.expiresAt <= timestamp;
        const ended = state === undefined || isTerminalAgentRunState(state);
        if (!expired && !ended) continue;
        try {
            // A live run may replace an expired grant by retrying its phase, so
            // that revocation is fenced by the expiry evaluated here. An ended
            // or missing run is never issued a replacement.
            await revoke(grant.runId, grant.phase, ended ? {} : { expiredBy: timestamp });
            revoked += 1;
            logger.info({ runId: grant.runId, phase: grant.phase, runState: state ?? null, expired }, 'Revoked leftover agent run MCP grant');
        } catch (error) {
            logger.warn({ runId: grant.runId, phase: grant.phase, err: error instanceof Error ? error.message : String(error) },
                'Could not revoke leftover agent run MCP grant; retrying on the next sweep');
        }
    }
    return revoked;
}

/** Runs `task` on every tick, skipping a tick while the previous run is still going. */
function serializedTick(name: string, task: () => Promise<unknown>): { tick: () => void; idle: () => Promise<void> } {
    let running: Promise<void> | null = null;
    return {
        tick: () => {
            if (running) return;
            running = task().then(() => undefined, (error: unknown) => {
                logger.error({ err: error }, `${name} failed`);
            }).finally(() => { running = null; });
        },
        idle: async () => { await running; },
    };
}

/**
 * Starts the agent run sweeps: schedule, deferred retry and stuck-run
 * recovery every `intervalMs`, grant cleanup every ten minutes. Each runs once
 * immediately. Returns a function that clears the intervals and waits for
 * in-flight sweeps.
 */
export function scheduleAgentRunSweeps(
    intervalMs = DEFAULT_AGENT_RUN_SWEEP_INTERVAL_MS,
    { grantCleanupIntervalMs = AGENT_RUN_GRANT_CLEANUP_INTERVAL_MS, deps = {}, grantCleanup = {} }: {
        grantCleanupIntervalMs?: number;
        deps?: AgentRunSweepDependencies;
        grantCleanup?: AgentRunGrantCleanupDependencies;
    } = {},
): () => Promise<void> {
    // One gate for both sweeps keeps its "usage unknown" log once per provider.
    const sweepDeps: AgentRunSweepDependencies = { ...deps, gate: deps.gate ?? createAgentRunCostGate({ now: deps.now }) };
    const runs = serializedTick('Agent run sweep', async () => {
        const steps: Array<[string, () => Promise<unknown>]> = [
            ['schedule', () => runAgentScheduleSweep(sweepDeps)],
            ['deferred retry', () => runDeferredAgentRunRetrySweep(sweepDeps)],
            ['stuck run recovery', () => recoverStuckAgentRuns(sweepDeps)],
        ];
        for (const [step, run] of steps) {
            try {
                await run();
            } catch (error) {
                logger.error({ step, err: error }, 'Agent run sweep step failed');
            }
        }
    });
    const grants = serializedTick('Agent run grant cleanup', () => cleanupAgentRunGrants(grantCleanup));

    runs.tick();
    grants.tick();
    const runTimer = setInterval(runs.tick, intervalMs);
    const grantTimer = setInterval(grants.tick, grantCleanupIntervalMs);
    logger.info({ intervalMs, grantCleanupIntervalMs }, 'Scheduled agent run sweeps');
    return async () => {
        clearInterval(runTimer);
        clearInterval(grantTimer);
        await Promise.all([runs.idle(), grants.idle()]);
    };
}
