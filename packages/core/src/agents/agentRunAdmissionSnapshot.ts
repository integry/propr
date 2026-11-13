/**
 * A read-only report of what physical agent-run admission enforces right now:
 * the global limit and its source, and globally and per direct agent alias the
 * ceiling and the executions holding, waiting for or deferred from a slot.
 *
 * It reads the same Redis records the atomic admission script decides on, in
 * one script call, so the counts are one consistent snapshot. It never exposes
 * holder tokens, container IDs, the stored daemon identity or any environment
 * value other than the limits themselves. Task IDs are returned for the caller
 * to filter by what its user may see; they are never part of the counts.
 *
 * The waiting set's members are bare holder tokens (`prepareAdmittedAgent`
 * zrem's them by token), so the alias and reason of each wait live beside it,
 * in the details hash (`agentAdmissionDetailsKey`).
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { agentAdmissionDetailsKey, agentAdmissionKeys, resolveAgentRunAdmission, type AdmissionConfig, type AgentAdmissionWaitReason } from './agentRunAdmission.js';
import { AGENT_RUN_ALIAS_LIMITS_ENV } from './agentRunAliasLimits.js';
import { agentCapacityWaitersPrefix, jobWaitsForAgentCapacity } from './agentCapacity.js';
import { AGENT_RUN_NESTED_LIMIT_ENV, DEFAULT_AGENT_RUN_NESTED_LIMIT } from './agentRunNesting.js';
import { repositoryWorkflowSlotUsage, type RepositoryWorkflowSlotUsage } from '../workflow/workflowSlotUsage.js';

/** Per token (in `agentAdmissionDetailsKey`): what the snapshot needs to know that the holder record and the waiting set do not say. */
export interface AgentAdmissionDetail {
    alias?: string;
    taskId?: string;
    /** Set while waiting, once the first acquire reply said why. */
    reason?: AgentAdmissionWaitReason;
    /** Epoch ms the wait (or, for a holder, the admission) began. */
    since?: number;
}


// Reads holders, the unexpired waiting set and the details in one snapshot, by
// Redis server time. Details of tokens that are neither holders nor waiting
// (a process that died while waiting, or a holder released by another
// process's recovery) are removed here: garbage only, never state admission reads.
const SNAPSHOT_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local holders = redis.call('HGETALL', KEYS[1])
local waiting = redis.call('ZRANGEBYSCORE', KEYS[2], '(' .. now, '+inf')
local details = redis.call('HGETALL', KEYS[3])
local known = {}
for i=1,#holders,2 do known[holders[i]] = true end
for _,member in ipairs(waiting) do known[member] = true end
local kept = {}
for i=1,#details,2 do
  if known[details[i]] then
    table.insert(kept, details[i]); table.insert(kept, details[i+1])
  else
    redis.call('HDEL', KEYS[3], details[i])
  end
end
return {tostring(now), holders, waiting, kept}
`;

export type AgentAdmissionHolderState = 'reserved' | 'running' | 'draining' | 'recovering';
export type AgentAdmissionStateCounts = Record<AgentAdmissionHolderState, number> & { total: number };

/** In-process acquires that have not been admitted yet, by why they wait. */
export interface AgentAdmissionWaitingCounts {
    total: number;
    /** Waiting because the instance-wide limit is full. */
    globalLimit: number;
    /** Waiting because the agent's own ceiling is full. */
    agentCeiling: number;
    /** Waiting until a holder whose lease expired is confirmed removed. */
    recovering: number;
    /** Registered, first acquire reply still pending. */
    starting: number;
}

export interface AgentAdmissionTaskRef {
    taskId: string;
    alias: string | null;
    state: AgentAdmissionHolderState | 'waiting';
    waitReason?: AgentAdmissionWaitReason | 'starting';
    nested: boolean;
    since?: string;
}

export interface AgentAdmissionAgentReport {
    alias: string;
    /** `PROPR_AGENT_RUN_ALIAS_LIMITS` entry; null = limited by the global limit only. */
    ceiling: number | null;
    /** What the ceiling is compared with: top-level holders plus nested executions counted against it. */
    inUse: number;
    /** Top-level executions of this agent, by state. */
    holders: AgentAdmissionStateCounts;
    nested: {
        total: number;
        /** Nested under a parent of the same agent: charged under the parent's slot, not counted again. */
        chargedUnderParent: number;
        /** Nested under a parent of another agent: counted against this agent's ceiling. */
        countedAgainstCeiling: number;
    };
    waiting: AgentAdmissionWaitingCounts;
    /** Queue jobs delayed until this agent has capacity (they release their worker while they wait). */
    deferred: number;
    tasks: AgentAdmissionTaskRef[];
}

export interface AgentRunAdmissionSnapshot {
    enabled: boolean;
    asOf: string;
    /** Present when admission is enabled. */
    global?: {
        limit: number;
        limitSource: 'PROPR_AGENT_RUN_LIMIT' | 'hosted_entitlement';
        generation: number;
        nestedLimit: number;
        nestedLimitSource: 'PROPR_AGENT_RUN_NESTED_LIMIT' | 'default';
        /** Top-level executions (each takes one global slot), by state. */
        inUse: number;
        holders: AgentAdmissionStateCounts;
        /** Top-level holders without an agent alias: pre-upgrade records and documented exemptions. */
        unattributedHolders: number;
        nested: { total: number; chargedUnderParent: number; countedAgainstOtherAgent: number };
        waiting: AgentAdmissionWaitingCounts;
        deferred: number;
    };
    agentCeilingsConfigured: boolean;
    agents: AgentAdmissionAgentReport[];
    /** The complete list of repositories with a limit and running work; empty only when read and none. */
    repositoryWorkflowSlots: RepositoryWorkflowSlotUsage[];
    /** Why repository workflow slot usage could not be read; `repositoryWorkflowSlots` is then empty and means unknown, not idle. */
    repositoryWorkflowSlotsUnavailable?: string;
    /** Why the admission part is missing although admission is enabled (Redis unavailable, invalid configuration). */
    unavailable?: string;
}

interface HolderRecord { state: AgentAdmissionHolderState; deadline?: number; alias?: string; parent?: string; shared?: boolean }

const emptyStates = (): AgentAdmissionStateCounts => ({ reserved: 0, running: 0, draining: 0, recovering: 0, total: 0 });
const emptyWaiting = (): AgentAdmissionWaitingCounts => ({ total: 0, globalLimit: 0, agentCeiling: 0, recovering: 0, starting: 0 });
const WAIT_FIELDS: Record<AgentAdmissionWaitReason, keyof AgentAdmissionWaitingCounts> = { global_limit: 'globalLimit', alias_limit: 'agentCeiling', recovering: 'recovering' };

function parseJson<T>(value: string): T | undefined {
    try { return JSON.parse(value) as T; } catch { return undefined; }
}

function pairs(flat: unknown): Array<[string, string]> {
    const list = Array.isArray(flat) ? flat.map(String) : [];
    const result: Array<[string, string]> = [];
    for (let i = 0; i + 1 < list.length; i += 2) result.push([list[i], list[i + 1]]);
    return result;
}

/** A holder whose lease passed (and is not a finished parent) is recovering in effect: only recovery frees it. */
function effectiveState(record: HolderRecord, now: number): AgentAdmissionHolderState {
    if (record.state === 'reserved' || record.state === 'running') {
        return typeof record.deadline === 'number' && record.deadline <= now ? 'recovering' : record.state;
    }
    return record.state === 'draining' ? 'draining' : 'recovering';
}

export interface AgentRunAdmissionSnapshotOptions {
    env?: NodeJS.ProcessEnv;
    /** Real Redis in tests; otherwise a short-lived connection to REDIS_HOST/REDIS_PORT. */
    client?: Redis;
    /** Admission configuration; resolved from `env` when absent. */
    config?: AdmissionConfig | null;
    /** BullMQ key prefix of the queues deferred jobs live in. */
    queuePrefix?: string;
}

function limitSource(env: NodeJS.ProcessEnv): 'PROPR_AGENT_RUN_LIMIT' | 'hosted_entitlement' {
    return env.PROPR_FLEET_CONTROL_SECRET ? 'hosted_entitlement' : 'PROPR_AGENT_RUN_LIMIT';
}

async function withClient<T>(client: Redis | undefined, operation: (client: Redis) => Promise<T>): Promise<T> {
    if (client) return operation(client);
    const owned = new Redis({
        host: process.env.REDIS_HOST || 'redis', port: Number(process.env.REDIS_PORT || 6379),
        connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true,
    });
    owned.on('error', error => logger.debug({ error: error.message }, 'Agent admission snapshot Redis unavailable'));
    try { await owned.connect(); return await operation(owned); }
    finally { owned.disconnect(); }
}

const sinceField = (detail: AgentAdmissionDetail) => detail.since ? { since: new Date(detail.since).toISOString() } : {};

/** Counts one snapshot's holders and waiters, globally and per alias. */
class AdmissionTally {
    readonly agents = new Map<string, AgentAdmissionAgentReport>();
    readonly holders = emptyStates();
    readonly nested = { total: 0, chargedUnderParent: 0, countedAgainstOtherAgent: 0 };
    readonly waiting = emptyWaiting();
    unattributed = 0;
    private readonly holderTokens = new Set<string>();

    constructor(private readonly ceilings: Readonly<Record<string, number>>, private readonly now: number, private readonly details: Map<string, AgentAdmissionDetail>) {
        for (const alias of Object.keys(ceilings)) this.agent(alias);
    }

    agent(alias: string): AgentAdmissionAgentReport {
        let entry = this.agents.get(alias);
        if (!entry) {
            entry = {
                alias, ceiling: Object.hasOwn(this.ceilings, alias) ? this.ceilings[alias] : null, inUse: 0, holders: emptyStates(),
                nested: { total: 0, chargedUnderParent: 0, countedAgainstCeiling: 0 }, waiting: emptyWaiting(), deferred: 0, tasks: [],
            };
            this.agents.set(alias, entry);
        }
        return entry;
    }

    holder(token: string, record: HolderRecord): void {
        this.holderTokens.add(token);
        const state = effectiveState(record, this.now);
        const entry = record.alias ? this.agent(record.alias) : undefined;
        if (record.parent) this.nestedHolder(record, entry);
        else {
            this.holders[state]++; this.holders.total++;
            if (entry) { entry.holders[state]++; entry.holders.total++; entry.inUse++; } else this.unattributed++;
        }
        const detail = this.details.get(token) ?? {};
        if (entry && detail.taskId) entry.tasks.push({ taskId: detail.taskId, alias: entry.alias, state, nested: Boolean(record.parent), ...sinceField(detail) });
    }

    /** Charged under its parent: no global slot; another alias's ceiling counts it. */
    private nestedHolder(record: HolderRecord, entry: AgentAdmissionAgentReport | undefined): void {
        this.nested.total++;
        if (record.shared) this.nested.chargedUnderParent++; else this.nested.countedAgainstOtherAgent++;
        if (!entry) return;
        entry.nested.total++;
        if (record.shared) entry.nested.chargedUnderParent++;
        else { entry.nested.countedAgainstCeiling++; entry.inUse++; }
    }

    waiter(token: string): void {
        if (this.holderTokens.has(token)) return; // admitted, its zrem not yet run
        const detail = this.details.get(token) ?? {};
        const field = detail.reason ? WAIT_FIELDS[detail.reason] : 'starting';
        this.waiting[field]++; this.waiting.total++;
        if (!detail.alias) return;
        const entry = this.agent(detail.alias);
        entry.waiting[field]++; entry.waiting.total++;
        if (detail.taskId) entry.tasks.push({ taskId: detail.taskId, alias: detail.alias, state: 'waiting', waitReason: detail.reason ?? 'starting', nested: false, ...sinceField(detail) });
    }
}

/** A waiter entry's `[queue, job]`, if well formed. */
function waiterJob(waiter: string): [string, string] | undefined {
    const parsed = parseJson<unknown>(waiter);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' ? [parsed[0], parsed[1]] : undefined;
}

/**
 * Every alias with a waiters list, found by key rather than by the current
 * ceilings: removing a ceiling (documented as needing no drain) leaves its
 * jobs delayed until their backoff passes, and they are still pending work.
 */
async function waiterAliases(client: Redis, instance: string, configured: Iterable<string>): Promise<Set<string>> {
    const prefix = agentCapacityWaitersPrefix(instance);
    const aliases = new Set(configured);
    // The prefix is a fixed string plus a hex hash, so it holds no glob characters.
    let cursor = '0';
    do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000);
        for (const key of keys) aliases.add(key.slice(prefix.length));
        cursor = next;
    } while (cursor !== '0');
    return aliases;
}

/**
 * Per alias, its waiters whose queue job is still delayed for it. Aliases with
 * a ceiling are always listed; an alias whose ceiling was removed is listed
 * while it still has such waiters.
 */
async function deferredWaiters(client: Redis, config: AdmissionConfig, prefix: string | undefined): Promise<Map<string, string[]>> {
    const queues = new Map<string, Queue>();
    const queue = (name: string) => {
        let found = queues.get(name);
        if (!found) queues.set(name, found = new Queue(name, { connection: client, ...(prefix ? { prefix } : {}) }));
        return found;
    };
    const isDelayed = async (waiter: string, alias: string): Promise<boolean> => {
        const target = waiterJob(waiter);
        if (!target) return false;
        try {
            const job = await queue(target[0]).getJob(target[1]);
            // Same rule as the wakeup: a stored refusal naming only other aliases no longer waits for this one.
            return Boolean(job && !job.finishedOn && jobWaitsForAgentCapacity(job.data, alias) && await job.isDelayed());
        } catch (error) {
            logger.debug({ error: (error as Error).message }, 'Could not read a deferred agent capacity waiter');
            return false;
        }
    };
    const configured = Object.keys(config.aliasLimits ?? {});
    const result = new Map<string, string[]>();
    try {
        const keyPrefix = agentCapacityWaitersPrefix(config.instance);
        for (const alias of await waiterAliases(client, config.instance, configured)) {
            const delayed: string[] = [];
            for (const waiter of await client.zrange(`${keyPrefix}${alias}`, 0, -1)) if (await isDelayed(waiter, alias)) delayed.push(waiter);
            if (delayed.length || configured.includes(alias)) result.set(alias, delayed);
        }
    } finally {
        await Promise.all([...queues.values()].map(item => item.close().catch(() => undefined)));
    }
    return result;
}

function globalSettings(config: AdmissionConfig, env: NodeJS.ProcessEnv) {
    return {
        limit: config.limit, limitSource: limitSource(env), generation: config.generation ?? 0,
        nestedLimit: config.nestedLimit ?? DEFAULT_AGENT_RUN_NESTED_LIMIT,
        nestedLimitSource: env[AGENT_RUN_NESTED_LIMIT_ENV]?.trim() ? 'PROPR_AGENT_RUN_NESTED_LIMIT' as const : 'default' as const,
    };
}

async function admissionPart(client: Redis, config: AdmissionConfig, env: NodeJS.ProcessEnv, prefix: string | undefined) {
    const [holdersKey, , waitingKey] = agentAdmissionKeys(config.instance);
    const [nowRaw, holdersFlat, waitingFlat, detailsFlat] = await client.eval(SNAPSHOT_SCRIPT, 3, holdersKey, waitingKey, agentAdmissionDetailsKey(config.instance)) as [string, string[], string[], string[]];
    const details = new Map(pairs(detailsFlat).map(([token, value]) => [token, parseJson<AgentAdmissionDetail>(value) ?? {}]));
    const tally = new AdmissionTally(config.aliasLimits ?? {}, Number(nowRaw), details);
    for (const [token, value] of pairs(holdersFlat)) {
        const record = parseJson<HolderRecord>(value);
        if (record) tally.holder(token, record);
    }
    for (const token of (waitingFlat ?? []).map(String)) tally.waiter(token);
    const deferred = new Set<string>();
    for (const [alias, waiters] of await deferredWaiters(client, config, prefix)) {
        tally.agent(alias).deferred = waiters.length;
        for (const waiter of waiters) deferred.add(waiter);
    }
    const { holders, nested, waiting } = tally;
    return {
        global: { ...globalSettings(config, env), inUse: holders.total, holders, unattributedHolders: tally.unattributed, nested, waiting, deferred: deferred.size },
        agents: [...tally.agents.values()].sort((left, right) => left.alias.localeCompare(right.alias)),
    };
}

const REDIS_UNAVAILABLE = 'Admission state could not be read from Redis';
const REPOSITORY_SLOTS_UNAVAILABLE = 'Repository workflow slots could not be read from Redis';

type RepositorySlots = Pick<AgentRunAdmissionSnapshot, 'repositoryWorkflowSlots' | 'repositoryWorkflowSlotsUnavailable'>;

async function repositorySlots(client: Redis): Promise<RepositorySlots> {
    try { return { repositoryWorkflowSlots: await repositoryWorkflowSlotUsage(client) }; }
    catch (error) {
        logger.debug({ error: (error as Error).message }, 'Repository workflow slot usage unavailable');
        return { repositoryWorkflowSlots: [], repositoryWorkflowSlotsUnavailable: REPOSITORY_SLOTS_UNAVAILABLE };
    }
}

/**
 * The admission report. With admission off (or its configuration invalid),
 * `enabled` is false (true) and only the repository workflow slots are read.
 * Never throws for a Redis or configuration failure: the admission part is
 * then reported `unavailable`, and repository slots that could not be read
 * `repositoryWorkflowSlotsUnavailable`, so neither reads as idle.
 */
export async function readAgentRunAdmissionSnapshot(options: AgentRunAdmissionSnapshotOptions = {}): Promise<AgentRunAdmissionSnapshot> {
    const env = options.env ?? process.env;
    const asOf = new Date().toISOString();
    let config: AdmissionConfig | null = null;
    let invalid: string | undefined;
    try { config = options.config !== undefined ? options.config : resolveAgentRunAdmission(env); }
    catch (error) {
        // The message names the variable and the rule, never its value beyond what it validated.
        invalid = `Invalid admission configuration: ${(error as Error).name}`;
    }
    const base = {
        enabled: Boolean(config) || invalid !== undefined, asOf, agents: [],
        agentCeilingsConfigured: invalid !== undefined ? Boolean(env[AGENT_RUN_ALIAS_LIMITS_ENV]?.trim()) : Boolean(config?.aliasLimits),
    };
    return withClient(options.client, async (client): Promise<AgentRunAdmissionSnapshot> => {
        const slots = await repositorySlots(client);
        if (invalid !== undefined) return { ...base, ...slots, unavailable: invalid };
        if (!config) return { ...base, ...slots };
        try {
            return { ...base, ...await admissionPart(client, config, env, options.queuePrefix), ...slots };
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Agent admission snapshot unavailable');
            return { ...base, ...slots, unavailable: REDIS_UNAVAILABLE };
        }
    }).catch(() => ({
        ...base, repositoryWorkflowSlots: [], repositoryWorkflowSlotsUnavailable: REPOSITORY_SLOTS_UNAVAILABLE,
        ...(invalid !== undefined ? { unavailable: invalid } : config ? { unavailable: REDIS_UNAVAILABLE } : {}),
    }));
}
