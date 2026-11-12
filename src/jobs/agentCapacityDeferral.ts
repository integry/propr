/**
 * Queue-job side of per-agent capacity (`PROPR_AGENT_RUN_ALIAS_LIMITS`).
 *
 * A job checks its direct agent's ceiling as soon as that agent is known and,
 * when it is full, persists an agent-capacity deferral and throws
 * AgentCapacityError; `deferCapacityJob` then moves the same job to delayed and
 * releases the worker, exactly like a repository capacity refusal. The atomic
 * acquire at container create stays authoritative.
 *
 * Without a per-agent policy every function here is a no-op, so no job is ever
 * deferred for agent capacity. `@propr/core` values are imported lazily: suites
 * that mock it with a fixed export list load this module indirectly.
 */
import type { AgentCapacityDeferralData, AgentCapacityJobContext, AgentCapacityReservation, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';
import { nextCapacityDeferral, recordCapacityDeferral } from './capacityDeferral.js';

type CapacityJob<T extends AgentCapacityDeferralData> = {
    data: T; updateData(data: T): Promise<unknown>; queueName?: string; id?: string | null;
};

export interface AgentCapacityRequest { agentAlias: string; model?: string }

interface RoutingRegistry { beginRoutingSession: Parameters<typeof import('@propr/core').reserveAgentCapacity>[0]['beginRoutingSession'] }

const core = () => import('@propr/core');

/**
 * How long a deferrable job that passed its pre-check may wait at the
 * authoritative acquire (it lost the race to another launch) before it gives
 * its worker back. Only job types that have done nothing user-visible by then
 * opt in.
 */
export const JOB_AGENT_CAPACITY_RACE_WAIT_MS = 30_000;

export const CLEARED_AGENT_CAPACITY_DEFERRAL: AgentCapacityDeferralData = {
    agentCapacityDeferrals: undefined, agentCapacityRetryAt: undefined, agentCapacityWaitingSince: undefined, agentCapacityAliases: undefined,
};

function waiterOf(job: { queueName?: string; id?: string | null }): string | undefined {
    return job.queueName && job.id ? JSON.stringify([job.queueName, job.id]) : undefined;
}

async function defaultRegistry(): Promise<RoutingRegistry> {
    const { AgentRegistry } = await core();
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    return registry;
}

function sameRequest(selection: { requestedAlias: string; requestedModel?: string }, request: AgentCapacityRequest): boolean {
    return selection.requestedAlias === request.agentAlias && (selection.requestedModel ?? '') === (request.model ?? '');
}

/**
 * Checks capacity for every agent request the job is about to run. Synthetic
 * requests select their member now (a saturated member of the tier is skipped
 * for one with room) and that choice is stored on the job, so a re-entered job
 * reuses it instead of selecting, and advancing the round-robin cursor, again.
 * Throws AgentCapacityError naming the saturated direct aliases. Returns the
 * context to run the job's agents under (pins for the chosen members), or
 * undefined when no per-agent policy is configured.
 */
export async function checkJobAgentCapacity<T extends AgentCapacityDeferralData>(
    job: CapacityJob<T>, requested: AgentCapacityRequest[] | (() => Promise<AgentCapacityRequest[]>), options: { registry?: RoutingRegistry; raceWaitMs?: number } = {},
): Promise<(AgentCapacityJobContext & { reservations: AgentCapacityReservation[] }) | undefined> {
    // Without a per-agent policy nothing loads, checks or changes (and core stays unloaded).
    if (!process.env.PROPR_AGENT_RUN_ALIAS_LIMITS?.trim()) return undefined;
    const capacity = await core();
    if (!capacity.agentCapacityPolicyConfigured()) return undefined;
    const registry = options.registry ?? await defaultRegistry();
    // Resolved only with a policy, so jobs without one never resolve their agent early.
    const requests = typeof requested === 'function' ? await requested() : requested;
    const previous = job.data.agentCapacitySelections ?? [];
    const reservations: AgentCapacityReservation[] = [];
    const saturated: string[] = [];
    const ceilings: Record<string, number> = {};
    for (const request of requests) {
        const pinnedMemberId = previous.find(selection => sameRequest(selection, request))?.memberId;
        try {
            const reservation = await capacity.reserveAgentCapacity(registry, { ...request, pinnedMemberId });
            if (reservation) reservations.push(reservation);
        } catch (error) {
            if (!capacity.isAgentCapacityError(error)) throw error;
            saturated.push(...error.aliases);
            Object.assign(ceilings, error.ceilings);
        }
    }
    // Kept for a re-entry (this deferral, or a later capacity wait before the agents run).
    const chosen = reservations.filter(reservation => reservation.memberId)
        .map(({ requestedAlias, requestedModel, directAlias, memberId }) => ({ requestedAlias, ...(requestedModel ? { requestedModel } : {}), directAlias, memberId }));
    const selections = [...previous.filter(selection => !chosen.some(kept => sameRequest(selection, { agentAlias: kept.requestedAlias, model: kept.requestedModel }))), ...chosen];
    if (JSON.stringify(selections) !== JSON.stringify(previous)) await job.updateData({ ...job.data, agentCapacitySelections: selections });
    if (saturated.length) throw new capacity.AgentCapacityError([...new Set(saturated)], ceilings);
    return { reservations, pins: capacity.agentCapacityPins(reservations), ...(options.raceWaitMs === undefined ? {} : { raceWaitMs: options.raceWaitMs }) };
}

/** The direct aliases a refusal names (an AgentCapacityError). */
function refusedAliases(error: unknown): string[] {
    const aliases = (error as { aliases?: unknown }).aliases;
    return Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string') : [];
}

function refusalReason(error: unknown): string {
    const ceilings = ((error as { ceilings?: Record<string, number> }).ceilings) ?? {};
    const names = refusedAliases(error).map(alias => ceilings[alias] === undefined ? alias : `${alias} (limit ${ceilings[alias]})`);
    return `Waiting for agent capacity${names.length ? `: ${names.join(', ')}` : ''}`;
}

/**
 * Durably store an agent-capacity refusal on the same job, join the waiting
 * list of every refused alias (oldest first) and explain the wait on the task
 * timeline: one row per wait, updated in place. Call before unwinding locks and
 * claims, then rethrow so `deferCapacityJob` delays the job. A refusal that
 * cannot be stored ends this attempt through `onPersistFailure`.
 */
export async function persistAgentCapacityDeferral<T extends AgentCapacityDeferralData>(options: {
    job: CapacityJob<T>; error: unknown; correlatedLogger: Logger; extraData?: Partial<T>;
    stateManager?: Pick<WorkerStateManager, 'getTaskState' | 'updateHistoryMetadata' | 'updateTaskStateIfCurrent'>; taskId?: string;
    onPersistFailure?(error: Error): Promise<void>;
    now?: number;
}): Promise<void> {
    const { job, error, correlatedLogger } = options;
    const capacity = await core();
    const now = options.now ?? Date.now();
    const aliases = refusedAliases(error);
    const since = job.data.agentCapacityWaitingSince ?? now;
    await capacity.registerAgentCapacityWaiter(aliases, waiterOf(job), since);
    const next = nextCapacityDeferral(job.data.agentCapacityDeferrals, { now });
    const deferrals = next.deferrals;
    let retryAt = next.retryAt;
    // A holder released between the pre-check and joining the list cannot have woken this job.
    if (aliases.length && (await Promise.all(aliases.map(alias => capacity.agentAliasHasCapacity(alias)))).every(Boolean)) retryAt = now + 250;
    try {
        await job.updateData({ ...job.data, ...options.extraData, agentCapacityDeferrals: deferrals, agentCapacityRetryAt: retryAt, agentCapacityWaitingSince: since, agentCapacityAliases: aliases });
    } catch (persistError) {
        await capacity.forgetAgentCapacityWaiter(aliases, waiterOf(job));
        if (options.onPersistFailure) await options.onPersistFailure(persistError as Error);
        throw persistError;
    }
    correlatedLogger.info({ taskId: options.taskId, aliases, deferrals, retryAt: new Date(retryAt).toISOString() }, 'Deferred job until its agent has capacity');
    if (options.stateManager && options.taskId) {
        await recordCapacityDeferral({
            kind: 'agent', stateManager: options.stateManager as WorkerStateManager, taskId: options.taskId, correlatedLogger,
            deferrals, retryAt, reason: refusalReason(error), metadata: { agentCapacityAliases: aliases },
        });
    }
}

/**
 * The job proceeds: end its agent-capacity wait (counters and waiting-list
 * entries). `keepSelections` retains the chosen synthetic members until the
 * agents actually run, for jobs that can still wait on repository capacity.
 */
export async function admitAgentCapacity<T extends AgentCapacityDeferralData>(job: CapacityJob<T>, options: { keepSelections?: boolean } = {}): Promise<void> {
    const waiting = job.data.agentCapacityAliases;
    const stale = !options.keepSelections && job.data.agentCapacitySelections !== undefined;
    if (!job.data.agentCapacityDeferrals && !waiting?.length && !stale) return;
    if (waiting?.length) await (await core()).forgetAgentCapacityWaiter(waiting, waiterOf(job));
    await job.updateData({ ...job.data, ...CLEARED_AGENT_CAPACITY_DEFERRAL, ...(options.keepSelections ? {} : { agentCapacitySelections: undefined }) });
}

/** Runs the job's agents with the pre-check's pinned members (and race bound); a no-op context without a policy. */
export async function runWithJobAgentCapacity<T>(context: AgentCapacityJobContext | undefined, operation: () => Promise<T>): Promise<T> {
    if (!context) return operation();
    return (await core()).runWithAgentCapacityContext(context, operation);
}

/**
 * A deferrable refusal (AgentCapacityError), by name; see the module comment.
 * An AgentCapacityWaitTimeoutError (the caller's own timeout expired while
 * waiting) is reported as a capacity wait, not deferred.
 */
export function isAgentCapacityRefusal(error: unknown): boolean {
    return (error as { name?: unknown } | null)?.name === 'AgentCapacityError';
}
