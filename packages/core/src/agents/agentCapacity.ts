/**
 * Per-agent capacity outside the physical admission boundary.
 *
 * The atomic Lua `acquire` in `agentRunAdmission.ts` stays the authoritative
 * check. This module lets queue jobs look at their direct agent's ceiling as
 * soon as that agent is known, so a job on a saturated alias is delayed and
 * releases its worker instead of polling at container create. It also keeps the
 * per-alias list of delayed waiters that a released holder wakes, oldest first.
 *
 * With no `PROPR_AGENT_RUN_ALIAS_LIMITS` entry for an alias, every check here
 * reports capacity without touching Redis, so nothing is ever deferred.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Job, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { agentAdmissionAliasHolders, agentAdmissionKeys, resolveAgentRunAdmission, type AdmissionConfig } from './agentRunAdmission.js';

/** The direct agent (alias) is at its ceiling; the caller should wait or defer. */
export class AgentCapacityError extends Error {
    readonly aliases: string[];
    readonly ceilings: Record<string, number>;
    constructor(aliases: string[], ceilings: Record<string, number> = {}, message?: string) {
        const names = aliases.map(alias => ceilings[alias] === undefined ? `'${alias}'` : `'${alias}' (limit ${ceilings[alias]})`).join(', ');
        super(message ?? `Waiting for agent capacity: ${names || 'agent'} at its ceiling`);
        this.name = 'AgentCapacityError';
        this.aliases = aliases;
        this.ceilings = ceilings;
    }
}

/** The caller's own timeout expired while the launch waited for its alias's ceiling. */
export class AgentCapacityWaitTimeoutError extends AgentCapacityError {
    constructor(alias: string, ceiling?: number) {
        super([alias], ceiling === undefined ? {} : { [alias]: ceiling },
            `Timed out waiting for agent capacity: '${alias}'${ceiling === undefined ? '' : ` (limit ${ceiling})`} stayed at its ceiling`);
        this.name = 'AgentCapacityWaitTimeoutError';
    }
}

/** By name, so copies of the class loaded through different module graphs still match. */
export function isAgentCapacityError(error: unknown): error is AgentCapacityError {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'AgentCapacityError' || name === 'AgentCapacityWaitTimeoutError';
}

// ---------------------------------------------------------------------------
// Redis access

let configuredClient: Redis | undefined;

/**
 * Runs `operation` with the configured connection, or a short-lived one that is
 * closed afterwards (a lingering connection would keep short-lived processes,
 * such as CLI commands and test runners, alive).
 */
async function withCapacityClient<T>(client: Redis | undefined, operation: (client: Redis) => Promise<T>): Promise<T> {
    const existing = client ?? configuredClient;
    if (existing) return operation(existing);
    const owned = new Redis({
        host: process.env.REDIS_HOST || 'redis', port: Number(process.env.REDIS_PORT || 6379),
        connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    owned.on('error', error => logger.debug({ error: error.message }, 'Agent capacity Redis unavailable'));
    try { return await operation(owned); }
    finally { owned.disconnect(); }
}

/** Test and embedding hook: use this connection for capacity checks, waiters and wake-ups. */
export function configureAgentCapacityRedis(client: Redis | undefined): void {
    configuredClient = client;
}

interface CapacityOptions { config?: AdmissionConfig | null; client?: Redis }

function aliasCeiling(config: AdmissionConfig | null | undefined, alias: string): number | undefined {
    return alias ? config?.aliasLimits?.[alias] : undefined;
}

/** Whether any per-agent ceiling is configured; without one no job is ever deferred for agent capacity. */
export function agentCapacityPolicyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    try { return !!resolveAgentRunAdmission(env)?.aliasLimits; } catch { return false; }
}

function resolveConfig(options: CapacityOptions): AdmissionConfig | null {
    if (options.config !== undefined) return options.config;
    try { return resolveAgentRunAdmission(); } catch { return null; }
}

/**
 * Whether `alias` has room under its ceiling right now. Advisory only: an alias
 * without a ceiling always has room here, and a Redis failure answers `true` so
 * the authoritative acquire (which fails closed) decides.
 */
export async function agentAliasHasCapacity(alias: string, options: CapacityOptions = {}): Promise<boolean> {
    const config = resolveConfig(options);
    const ceiling = aliasCeiling(config, alias);
    if (!config || ceiling === undefined) return true;
    try {
        const holders = await withCapacityClient(options.client, client => agentAdmissionAliasHolders(client, config.instance));
        return (holders[alias] ?? 0) < ceiling;
    } catch (error) {
        logger.debug({ alias, error: (error as Error).message }, 'Agent capacity pre-check unavailable; the admission boundary decides');
        return true;
    }
}

/** Throws AgentCapacityError naming every saturated alias among `aliases`. */
export async function assertAgentAliasCapacity(aliases: string | Iterable<string>, options: CapacityOptions = {}): Promise<void> {
    const config = resolveConfig(options);
    const unique = [...new Set(typeof aliases === 'string' ? [aliases] : aliases)].filter(alias => aliasCeiling(config, alias) !== undefined);
    if (!config || unique.length === 0) return;
    const saturated: string[] = [];
    for (const alias of unique) if (!await agentAliasHasCapacity(alias, { ...options, config })) saturated.push(alias);
    if (saturated.length) throw new AgentCapacityError(saturated, Object.fromEntries(saturated.map(alias => [alias, aliasCeiling(config, alias)!])));
}

// ---------------------------------------------------------------------------
// Waiters: delayed queue jobs, oldest first, woken when their alias frees up

/** Sorted set of `[queueName, jobId]` waiters for one alias, scored by when each began waiting. */
export function agentCapacityWaitersKey(instance: string, alias: string): string {
    // Same hash tag as the admission keys, so they share a cluster slot.
    return `${agentAdmissionKeys(instance)[0].replace(/:holders$/, '')}:alias-waiters:${alias}`;
}

/** Adds the job to each alias's waiting list, keeping its original position. Best effort. */
export async function registerAgentCapacityWaiter(aliases: string[], waiter: string | undefined, since: number, options: CapacityOptions = {}): Promise<void> {
    const config = resolveConfig(options);
    if (!config || !waiter) return;
    const capped = aliases.filter(alias => aliasCeiling(config, alias) !== undefined);
    if (!capped.length) return;
    try {
        await withCapacityClient(options.client, async client => {
            for (const alias of capped) await client.zadd(agentCapacityWaitersKey(config.instance, alias), 'NX', since, waiter);
        });
    } catch (error) { logger.debug({ aliases: capped, error: (error as Error).message }, 'Could not register agent capacity waiter'); }
}

/** Removes the job from the waiting lists once it no longer waits. Best effort. */
export async function forgetAgentCapacityWaiter(aliases: string[], waiter: string | undefined, options: CapacityOptions = {}): Promise<void> {
    const config = resolveConfig(options);
    if (!config || !waiter) return;
    if (!aliases.length) return;
    try {
        await withCapacityClient(options.client, async client => {
            for (const alias of aliases) await client.zrem(agentCapacityWaitersKey(config.instance, alias), waiter);
        });
    } catch (error) { logger.debug({ aliases, error: (error as Error).message }, 'Could not remove agent capacity waiter'); }
}

/**
 * Promote the oldest delayed waiters of `alias`, one per free slot under its
 * ceiling. Called whenever a holder of the alias is released, in whichever
 * process (worker or API) ran it. A waiter that is not delayed right now is
 * re-entering anyway; one whose job no longer exists leaves the list without
 * using up the wakeup. The backoff timer still covers a missed wakeup.
 */
export async function wakeAgentCapacityWaiters(alias: string, options: CapacityOptions = {}): Promise<number> {
    const config = resolveConfig(options);
    const ceiling = aliasCeiling(config, alias);
    if (!config || ceiling === undefined) return 0;
    return withCapacityClient(options.client, async client => {
        const key = agentCapacityWaitersKey(config.instance, alias);
        const holders = await agentAdmissionAliasHolders(client, config.instance);
        const free = ceiling - (holders[alias] ?? 0);
        if (free <= 0) return 0;
        const queues = new Map<string, Queue>();
        let woken = 0;
        try {
            for (const waiter of await client.zrange(key, 0, -1)) {
                if (woken >= free) break;
                try {
                    const [queueName, jobId] = JSON.parse(waiter) as [string, string];
                    let queue = queues.get(queueName);
                    if (!queue) queues.set(queueName, queue = new Queue(queueName, { connection: client }));
                    const job = await Job.fromId(queue, jobId);
                    // A finished (or cancelled and removed) job no longer waits.
                    if (!job || job.finishedOn) { await client.zrem(key, waiter); continue; }
                    woken++;
                    if (await job.isDelayed()) await job.promote();
                } catch (error) {
                    logger.debug({ alias, waiter, error: (error as Error).message }, 'Could not wake agent capacity waiter');
                }
            }
        } finally {
            // The connection belongs to the caller (or to withCapacityClient); keep it open.
            await Promise.all([...queues.values()].map(queue => queue.close().catch(() => undefined)));
        }
        return woken;
    });
}

// ---------------------------------------------------------------------------
// Job context: synthetic selections remembered across a deferral, and how long
// a lost race at the authoritative acquire may wait before it becomes a deferral

export interface AgentCapacityJobContext {
    /** Synthetic member chosen by the job's capacity pre-check, keyed by `alias:model`. Consumed by the first executeTask. */
    pins?: Map<string, string>;
    /**
     * When set, an alias-ceiling wait at the acquire longer than this throws
     * AgentCapacityError so the job can defer. Unset: the launch keeps waiting.
     */
    raceWaitMs?: number;
}

const jobContext = new AsyncLocalStorage<AgentCapacityJobContext>();

export function runWithAgentCapacityContext<T>(context: AgentCapacityJobContext, operation: () => Promise<T>): Promise<T> {
    return jobContext.run(context, operation);
}

export function agentCapacityPinKey(alias: string, model: string | undefined): string {
    return `${alias}:${model ?? ''}`;
}

/** The pre-selected member for this synthetic request, once. */
export function takeAgentCapacityPin(alias: string, model: string | undefined): string | undefined {
    const pins = jobContext.getStore()?.pins;
    if (!pins) return undefined;
    // A reservation made without a model pins the request's default model.
    for (const key of [agentCapacityPinKey(alias, model), agentCapacityPinKey(alias, undefined)]) {
        const pinned = pins.get(key);
        if (pinned === undefined) continue;
        pins.delete(key);
        return pinned;
    }
    return undefined;
}

export function agentCapacityRaceWaitMs(): number | undefined {
    return jobContext.getStore()?.raceWaitMs;
}

/**
 * Tracks how long an acquire has waited on its alias's own ceiling. A
 * deferrable job (race bound set) that waits longer gets AgentCapacityError so
 * it can give its worker back; when the caller's own timeout ends such a wait,
 * the launch reports a capacity wait instead of a provider timeout.
 */
export function aliasCapacityWait(alias: string, ceiling: string, options: { capacityRaceWaitMs?: number; timeoutReason?: unknown }) {
    const raceWaitMs = options.capacityRaceWaitMs ?? agentCapacityRaceWaitMs();
    let since: number | undefined;
    return {
        observe(result: unknown) {
            since = result === 3 ? since ?? Date.now() : undefined;
            if (since !== undefined && raceWaitMs !== undefined && Date.now() - since >= raceWaitMs) {
                throw new AgentCapacityError([alias], { [alias]: Number(ceiling) });
            }
        },
        async pause(ms: number, signal: AbortSignal) {
            try { await delay(ms, undefined, { signal }); }
            catch (error) {
                if (since !== undefined && options.timeoutReason !== undefined && signal.reason === options.timeoutReason) {
                    throw new AgentCapacityWaitTimeoutError(alias, Number(ceiling));
                }
                throw error;
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Pre-check for a requested (direct or synthetic) agent

export interface AgentCapacityReservation {
    requestedAlias: string;
    requestedModel?: string;
    /** The direct agent that will be charged. */
    directAlias: string;
    /** Synthetic member chosen with capacity in mind; reused after a deferral. */
    memberId?: string;
}

interface RoutingRegistry {
    beginRoutingSession(options: { requestedAgentAlias: string; requestedModel?: string; pinnedMemberId?: string; deferOnCapacity?: boolean }): {
        select(): Promise<{ physicalAgentAlias: string; physicalModel: string; memberId?: string; synthetic: boolean }>;
    };
}

/**
 * Resolves the direct agent a request will be charged to and checks its
 * ceiling. A synthetic request selects a member now, skipping saturated members
 * of its priority tier; `pinnedMemberId` reuses an earlier selection without
 * advancing the round-robin cursor. Throws AgentCapacityError when no eligible
 * member (or the direct agent) has room. Returns null when no per-agent policy
 * is configured: the request then routes lazily exactly as before.
 */
export async function reserveAgentCapacity(
    registry: RoutingRegistry, request: { agentAlias: string; model?: string; pinnedMemberId?: string },
): Promise<AgentCapacityReservation | null> {
    if (!agentCapacityPolicyConfigured()) return null;
    const session = registry.beginRoutingSession({
        requestedAgentAlias: request.agentAlias, requestedModel: request.model, pinnedMemberId: request.pinnedMemberId, deferOnCapacity: true,
    });
    let selection: Awaited<ReturnType<ReturnType<RoutingRegistry['beginRoutingSession']>['select']>>;
    try {
        selection = await session.select();
    } catch (error) {
        if (!isAgentCapacityError(error)) throw error;
        // Name each saturated alias with its configured ceiling.
        const limits = resolveConfig({})?.aliasLimits ?? {};
        throw new AgentCapacityError(error.aliases, { ...Object.fromEntries(error.aliases.filter(alias => limits[alias] !== undefined).map(alias => [alias, limits[alias]])), ...error.ceilings });
    }
    if (!selection.synthetic) await assertAgentAliasCapacity(selection.physicalAgentAlias);
    return {
        requestedAlias: request.agentAlias, ...(request.model ? { requestedModel: request.model } : {}),
        directAlias: selection.physicalAgentAlias, ...(selection.memberId ? { memberId: selection.memberId } : {}),
    };
}

/** Pins a reservation's synthetic member for the job's later executeTask. */
export function agentCapacityPins(reservations: Array<AgentCapacityReservation | null | undefined>): Map<string, string> {
    const pins = new Map<string, string>();
    for (const reservation of reservations) {
        if (reservation?.memberId) pins.set(agentCapacityPinKey(reservation.requestedAlias, reservation.requestedModel), reservation.memberId);
    }
    return pins;
}
