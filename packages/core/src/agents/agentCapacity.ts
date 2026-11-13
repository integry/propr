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
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { agentAdmissionKeys, resolveAgentRunAdmission, type AdmissionConfig, type AdmissionRedis } from './agentRunAdmission.js';
import { agentRunAliasCeiling } from './agentRunAliasLimits.js';
import { currentAgentAdmissionNesting } from './agentRunNesting.js';

/** The direct agent (alias) is at its ceiling; the caller should wait or defer. */
export class AgentCapacityError extends Error {
    readonly aliases: string[];
    readonly ceilings: Record<string, number>;
    constructor(aliases: string[], ceilings: Record<string, number> = {}, message?: string) {
        const names = aliases.map(alias => Object.hasOwn(ceilings, alias) ? `'${alias}' (limit ${ceilings[alias]})` : `'${alias}'`).join(', ');
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
    return agentRunAliasCeiling(config?.aliasLimits, alias);
}

/** The configured ceiling of `alias` (`PROPR_AGENT_RUN_ALIAS_LIMITS`), if any; for messages and reports. */
export function agentAliasCeiling(alias: string, options: CapacityOptions = {}): number | undefined {
    return aliasCeiling(resolveConfig(options), alias);
}

/** Whether any per-agent ceiling is configured; without one no job is ever deferred for agent capacity. */
export function agentCapacityPolicyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    try { return !!resolveAgentRunAdmission(env)?.aliasLimits; } catch { return false; }
}

function resolveConfig(options: CapacityOptions): AdmissionConfig | null {
    if (options.config !== undefined) return options.config;
    try { return resolveAgentRunAdmission(); } catch { return null; }
}

// Read-only. Classifies each aliased holder by Redis server time, the same
// clock the admission script's `expired` uses: `recoverable` holders (deadline
// passed, or already `recovering`) still occupy their alias, but only an
// admission attempt's recovery can free them. The first reply element is 1
// when the stored admission configuration has an older generation than the
// caller's (ARGV[1]): the caller's first admission attempt reconciles it,
// fencing and draining every older holder. Read with the holders, in one
// snapshot. An unreadable configuration is left for the acquire to reject.
const OCCUPANCY_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local reconcile = 0
local stored = redis.call('GET', KEYS[2])
if stored then
  local ok, config = pcall(cjson.decode, stored)
  if ok and type(config) == 'table' and (tonumber(config.generation) or 0) < tonumber(ARGV[1]) then reconcile = 1 end
end
local live, recoverable = {}, {}
local all, parents, stranded = redis.call('HGETALL', KEYS[1]), {}, {}
for i=1,#all,2 do
  local r = cjson.decode(all[i+1])
  if r.parent then
    parents[r.parent] = true
    -- A nested execution whose process may be gone: only recovery frees it.
    if r.state == 'recovering' or r.deadline <= now then stranded[r.parent] = true end
  end
end
for i=1,#all,2 do
  local r = cjson.decode(all[i+1])
  -- A nested execution on its parent's alias is charged under the parent's
  -- slot. A finished (draining) parent keeps its slot while nested work runs;
  -- without any, only recovery frees it. Nor can a nested execution that
  -- expired or is recovering, whatever its alias, so its draining parent lets
  -- jobs reach the acquire: its recovery releases that child (and the parent
  -- after its last one), and it refuses to reuse the slot while live ones remain.
  if r.alias and not r.shared then
    if r.state == 'recovering' or (r.state == 'draining' and (not parents[all[i]] or stranded[all[i]])) or (r.state ~= 'draining' and r.deadline <= now) then
      recoverable[r.alias] = (recoverable[r.alias] or 0) + 1
    else
      live[r.alias] = (live[r.alias] or 0) + 1
    end
  end
end
local result = {reconcile}
for alias, count in pairs(live) do table.insert(result, alias); table.insert(result, count); table.insert(result, 0) end
for alias, count in pairs(recoverable) do table.insert(result, alias); table.insert(result, 0); table.insert(result, count) end
return result
`;

export interface AgentAliasOccupancy { live: number; recoverable: number }

export interface AgentAdmissionOccupancy {
    /** Holders per direct agent alias. A Map, so any valid alias (even `constructor`) reads only its own entry. */
    aliases: Map<string, AgentAliasOccupancy>;
    /** The stored admission configuration has an older generation than the caller's. */
    reconciliationPending: boolean;
}

/** Holders per direct agent alias, split into `live` ones (deadline not yet
 * passed) and `recoverable` ones (expired, or `recovering`). A recoverable
 * holder still occupies its alias, but its process may be gone, so nothing
 * but the recovery in an admission attempt will ever release it: a capacity
 * pre-check must let such a job reach the acquire rather than defer it.
 * `generation` is the caller's admission generation (absent = 0). */
export async function agentAdmissionAliasOccupancy(client: Pick<AdmissionRedis, 'eval'>, instance: string, generation = 0): Promise<AgentAdmissionOccupancy> {
    const [holders, configKey] = agentAdmissionKeys(instance);
    const [reconcile, ...rows] = await client.eval(OCCUPANCY_SCRIPT, 2, holders, configKey, String(generation)) as Array<string | number>;
    const aliases = new Map<string, AgentAliasOccupancy>();
    for (let i = 0; i < rows.length; i += 3) {
        const alias = String(rows[i]);
        const entry = aliases.get(alias) ?? { live: 0, recoverable: 0 };
        aliases.set(alias, entry);
        entry.live += Number(rows[i + 1]);
        entry.recoverable += Number(rows[i + 2]);
    }
    return { aliases, reconciliationPending: Number(reconcile) === 1 };
}

/**
 * Holders of `alias` that block a job from reaching the acquire: only live
 * ones, and none while the caller's newer admission generation is still to be
 * reconciled. That reconciliation (fence every older holder, remove its
 * container, release it) runs only inside an admission attempt, so counting
 * older-generation holders here would defer every job of the new generation
 * before any reached it, for as long as the old processes keep renewing.
 */
async function blockingAliasHolders(client: Redis, config: AdmissionConfig, alias: string): Promise<number> {
    const { aliases, reconciliationPending } = await agentAdmissionAliasOccupancy(client, config.instance, config.generation ?? 0);
    return reconciliationPending ? 0 : aliases.get(alias)?.live ?? 0;
}

// The alias of the live holder registered under a parent scope ('' = none or
// unattributed). Same liveness rule as the admission script's nested acquire.
const PARENT_ALIAS_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local token = redis.call('HGET', KEYS[2], ARGV[1])
local value = token and redis.call('HGET', KEYS[1], token)
if not value then return '' end
local r = cjson.decode(value)
if r.state == 'recovering' or r.state == 'draining' or r.deadline <= now then return '' end
return r.alias or ''
`;

async function liveParentAlias(client: Redis, config: AdmissionConfig, scope: string): Promise<string> {
    const [holders, , , parents] = agentAdmissionKeys(config.instance);
    return String(await client.eval(PARENT_ALIAS_SCRIPT, 2, holders, parents, scope) ?? '');
}

/**
 * Whether `alias` has room under its ceiling right now, or a holder that only
 * recovery can free. Advisory only: an alias without a ceiling always has room
 * here, and a Redis failure answers `true` so the authoritative acquire (which
 * fails closed) decides.
 *
 * An expired or `recovering` holder still occupies its alias until recovery
 * confirms its container is gone, but recovery is demand-driven: it runs only
 * inside an admission attempt. Counting such a holder here would defer every
 * job of the alias before any reached that recovery, so a holder whose process
 * died would block the alias forever. Those jobs proceed to the acquire, which
 * recovers (removal confirmed before reuse) and then admits or waits. For the
 * same reason a caller whose admission generation is newer than the stored
 * one always proceeds: its acquire fences and drains the older holders.
 */
export async function agentAliasHasCapacity(alias: string, options: CapacityOptions = {}): Promise<boolean> {
    const config = resolveConfig(options);
    const ceiling = aliasCeiling(config, alias);
    if (!config || ceiling === undefined) return true;
    const parentScope = currentAgentAdmissionNesting()?.parent;
    try {
        return await withCapacityClient(options.client, async client => {
            // Work on behalf of a live parent on this alias is charged under the
            // parent's slot: deferring it would wait for the parent, which waits for it.
            if (parentScope && await liveParentAlias(client, config, parentScope) === alias) return true;
            return await blockingAliasHolders(client, config, alias) < ceiling;
        });
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

/** False when the job's stored refusal names only other aliases: it no longer waits for this one. */
function waitsFor(data: unknown, alias: string): boolean {
    const aliases = (data as { agentCapacityAliases?: unknown } | null | undefined)?.agentCapacityAliases;
    return !Array.isArray(aliases) || aliases.includes(alias);
}

/**
 * Promote the oldest delayed waiters of `alias`, one per free slot under its
 * ceiling. Called whenever a holder of the alias is released, in whichever
 * process (worker or API) ran it. A waiter that is not delayed right now is
 * re-entering anyway; one whose job no longer exists, or whose stored refusal no
 * longer names this alias, leaves the list without using up the wakeup. The backoff timer still covers a missed wakeup.
 */
export async function wakeAgentCapacityWaiters(alias: string, options: CapacityOptions = {}): Promise<number> {
    const config = resolveConfig(options);
    const ceiling = aliasCeiling(config, alias);
    if (!config || ceiling === undefined) return 0;
    return withCapacityClient(options.client, async client => {
        const key = agentCapacityWaitersKey(config.instance, alias);
        // Same rule as the pre-check: a woken job may be the one that recovers an expired holder,
        // or reconciles this process's newer admission generation.
        const free = ceiling - await blockingAliasHolders(client, config, alias);
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
                    const job = await queue.getJob(jobId);
                    // A finished (or cancelled and removed) job no longer waits.
                    if (!job || job.finishedOn) { await client.zrem(key, waiter); continue; }
                    // Waiting for other aliases only. A delayed job has stored its latest refusal, so the
                    // entry is obsolete. One that is not delayed may be joining this list right now (its new
                    // aliases not yet stored): keep the entry, its own post-registration capacity check covers this release.
                    const waiting = waitsFor(job.data, alias);
                    if (!waiting && await job.isDelayed()) { await client.zrem(key, waiter); continue; }
                    if (!waiting) continue;
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
    // The caller's own timeout can land anywhere in the wait loop (a Redis call,
    // the cancellation check, the pause): while waiting on the ceiling, it is a capacity wait.
    const failure = (error: unknown, signal: AbortSignal): unknown =>
        since !== undefined && options.timeoutReason !== undefined && signal.aborted && signal.reason === options.timeoutReason
            ? new AgentCapacityWaitTimeoutError(alias, Number(ceiling))
            : error;
    return {
        failure,
        observe(result: unknown) {
            since = result === 3 ? since ?? Date.now() : undefined;
            if (since !== undefined && raceWaitMs !== undefined && Date.now() - since >= raceWaitMs) {
                throw new AgentCapacityError([alias], { [alias]: Number(ceiling) });
            }
        },
        async pause(ms: number, signal: AbortSignal) {
            try { await delay(ms, undefined, { signal }); }
            catch (error) { throw failure(error, signal); }
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
        const config = resolveConfig({});
        const limits = error.aliases.flatMap(alias => { const ceiling = aliasCeiling(config, alias); return ceiling === undefined ? [] : [[alias, ceiling] as const]; });
        throw new AgentCapacityError(error.aliases, { ...Object.fromEntries(limits), ...error.ceilings });
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
