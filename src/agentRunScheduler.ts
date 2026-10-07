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
    claimAgentDefinitionScheduleSlot,
    createAgentRunCostGate,
    db,
    disableAgentDefinitionSchedule,
    listDueScheduledAgentDefinitions,
    logger,
    recordSkippedRun,
    rowToAgentRun,
    retryDueDeferredAgentRuns,
    transitionAgentRun,
    triggerAgentRun,
    type AgentRunEnqueue,
    type AgentRunGate,
    type AgentRunRow,
    type DeferredAgentRunRetryResult,
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
 *   on `next_run_at` lets one sweep claim a slot, and the run's idempotency key
 *   `schedule:<slot ISO>` makes a replay of the same slot return the same run.
 *   Missed slots coalesce into one run for the latest due slot.
 * - deferred retry: re-evaluates deferred runs through the cost gate.
 * - stuck runs: fails `running`/`acting` runs whose task ended long ago, i.e.
 *   the worker stopped before recording the result.
 * - grant cleanup (slower cadence): revokes run-scoped MCP grants left behind
 *   by terminal runs or past their expiry, a backstop for crashed workers.
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
/** Bounds the walk over missed slots; a cron has at least 15 minutes between firings. */
const MAX_COALESCED_SLOTS = 10_000;

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
    /** Slots recorded as `skipped` because the definition no longer validates. */
    invalid: number;
    /** Definitions whose schedule was turned off. */
    disabled: number;
    /** Slots another sweep claimed first. */
    lost: number;
    failed: number;
}

type ScheduleOutcome = Exclude<keyof AgentScheduleSweepResult, 'failed'> | null;

function bootstrapAdminUsernames(environment: NodeJS.ProcessEnv = process.env): string[] {
    return (environment.PROPR_ADMIN_USERS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * Whether an agent owner is still an instance member: an explicit
 * `instance_members` row or a bootstrap administrator (`PROPR_ADMIN_USERS`),
 * and allowed by the GitHub user whitelist when one is configured. Mirrors
 * `resolveInstanceAuthorization` in the API, which core cannot import.
 */
export async function isAgentOwnerInstanceMember(ownerId: string, database: Knex = db): Promise<boolean> {
    const member = await database('instance_members').where({ github_user_id: ownerId })
        .first<{ github_username?: string } | undefined>('github_username');
    const grant = await database('github_user_grants').where({ github_user_id: ownerId })
        .first<{ github_username?: string } | undefined>('github_username')
        .catch(() => undefined);
    const username = grant?.github_username || member?.github_username || null;
    if (getGithubUserWhitelist().length > 0 && !isGithubUserWhitelisted(username)) return false;
    if (member) return true;
    return username !== null && bootstrapAdminUsernames().includes(username.toLowerCase());
}

/**
 * The latest slot at or before `now`, walking forward from the claimed one.
 * The claimed slot is due, so the result is never earlier than it.
 */
function latestDueSlot(cron: ParsedCronExpression, claimedSlot: number, now: number): number {
    let slot = claimedSlot;
    for (let step = 0; step < MAX_COALESCED_SLOTS; step++) {
        const following = nextCronOccurrence(cron, new Date(slot)).getTime();
        if (following > now) return slot;
        slot = following;
    }
    return slot;
}

interface ScheduleContext {
    now: number;
    database?: Knex;
    trigger: NonNullable<AgentRunSweepDependencies['trigger']>;
    gate: AgentRunGate;
    isMember: NonNullable<AgentRunSweepDependencies['isMember']>;
    clock: () => number;
}

async function disableSchedule(definition: StoredAgentDefinition, reason: string, context: ScheduleContext): Promise<ScheduleOutcome> {
    const disabled = await disableAgentDefinitionSchedule(definition.id, { database: context.database, now: context.clock });
    logger.warn({ definitionId: definition.id, ownerId: definition.ownerId, decision: 'schedule_disabled', reason },
        'Disabled agent schedule');
    return disabled ? 'disabled' : null;
}

async function fireDueDefinition(due: StoredAgentDefinition, context: ScheduleContext): Promise<ScheduleOutcome> {
    const claimedSlot = due.nextRunAt!;
    let cron: ParsedCronExpression;
    let next: number;
    let slot: number;
    try {
        cron = parseCronExpression(due.scheduleCron ?? '');
        next = nextCronOccurrence(cron, new Date(context.now)).getTime();
        slot = latestDueSlot(cron, claimedSlot, context.now);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return disableSchedule(due, `The schedule cannot be evaluated: ${message}`, context);
    }

    // Only one sweep moves next_run_at off the value it read; the others stop here.
    const definition = await claimAgentDefinitionScheduleSlot(due.id, claimedSlot, next, { database: context.database });
    if (!definition) return 'lost';

    // An offboarded owner's agent must stop running.
    if (!await context.isMember(definition.ownerId)) {
        return disableSchedule(definition, 'The owner is no longer an instance member', context);
    }

    const slotIso = new Date(slot).toISOString();
    const triggerSource = `schedule:${definition.scheduleCron}`;
    const idempotencyKey = `schedule:${slotIso}`;
    try {
        const { run, created } = await context.trigger({ definition, trigger: 'schedule', triggerSource, idempotencyKey, gate: context.gate });
        logger.info({ definitionId: definition.id, slot: slotIso, runId: run.id, decision: created ? run.state : 'existing' },
            'Scheduled agent run');
        return created ? 'created' : 'existing';
    } catch (error) {
        if (!(error instanceof AgentRunTriggerError) || error.code !== 'AGENT_INVALID') throw error;
        // The history shows why the slot did not run.
        const { run, created } = await recordSkippedRun({
            definition, trigger: 'schedule', triggerSource, idempotencyKey,
            skipReason: `The scheduled run was skipped: ${error.message}`,
        }, { database: context.database, now: context.clock });
        logger.info({ definitionId: definition.id, slot: slotIso, runId: run.id, decision: 'skipped', reason: error.message },
            'Scheduled agent run');
        return created ? 'invalid' : 'existing';
    }
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
    const context: ScheduleContext = { now, database, trigger, gate, isMember, clock };
    for (const definition of due) {
        try {
            const outcome = await fireDueDefinition(definition, context);
            if (outcome) result[outcome] += 1;
        } catch (error) {
            result.failed += 1;
            logger.error({ definitionId: definition.id, slot: definition.nextRunAt, err: error }, 'Could not fire scheduled agent run');
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

/** Runs in any of `states`, least recently updated first. */
async function listAgentRunsInStates(states: readonly AgentRunState[], limit: number, database: Knex): Promise<StoredAgentRun[]> {
    const rows = await database('agent_runs').whereIn('state', [...states])
        .orderBy([{ column: 'updated_at', order: 'asc' }, { column: 'id', order: 'asc' }])
        .limit(limit).select<AgentRunRow[]>();
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
    const runs = (await listAgentRunsInStates(['running', 'acting'], STUCK_RUN_BATCH_SIZE, database))
        .filter(run => activeTaskId(run) !== null);
    if (runs.length === 0) return 0;
    const taskIds = [...new Set(runs.map(run => activeTaskId(run)!))];
    const history = await database('task_history').whereIn('task_id', taskIds)
        .orderBy([{ column: 'task_id', order: 'asc' }, { column: 'history_id', order: 'desc' }])
        .select<{ task_id: string; state: string; timestamp: unknown }[]>('task_id', 'state', 'timestamp');
    const latest = new Map<string, { state: string; at: number | null }>();
    for (const row of history) {
        if (!latest.has(row.task_id)) latest.set(row.task_id, { state: row.state, at: toEpochMs(row.timestamp) });
    }

    const cutoff = now() - AGENT_RUN_STUCK_GRACE_MS;
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
    /** Revokes one run phase's grant through the API's internal route. */
    revoke?: (runId: string, phase: AgentRunPhase) => Promise<void>;
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
        revoke = (runId, phase) => revokeAgentRunMcpGrant(runId, { phase }),
    } = deps;
    const records = await database('mcp_records').where({ kind: AGENT_RUN_GRANT_RECORD_KIND })
        .orderBy([{ column: 'expires_at', order: 'asc' }, { column: 'id', order: 'asc' }])
        .limit(GRANT_CLEANUP_BATCH_SIZE)
        .select<{ id: string; expires_at: number | string | null }[]>('id', 'expires_at');
    const grants = records.flatMap(record => {
        const parsed = parseGrantRecordId(record.id);
        return parsed ? [{ ...parsed, expiresAt: record.expires_at == null ? null : Number(record.expires_at) }] : [];
    });
    if (grants.length === 0) return 0;

    const states = await getAgentRunStates(grants.map(grant => grant.runId), database);
    const timestamp = now();
    let revoked = 0;
    for (const grant of grants) {
        const state = states.get(grant.runId);
        const expired = grant.expiresAt !== null && grant.expiresAt <= timestamp;
        const ended = state === undefined || isTerminalAgentRunState(state);
        if (!expired && !ended) continue;
        try {
            await revoke(grant.runId, grant.phase);
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
