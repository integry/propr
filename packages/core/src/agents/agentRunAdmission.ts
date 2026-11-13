import { randomUUID, createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { checkAbortSignal, plannerAbortSignalKeyForTask } from '../claude/docker/dockerAbortController.js';
import { ExecutionAbortedError, getExecutionAbortError } from '../claude/docker/dockerExecutionOwnership.js';
import { assertNativeLogAdmission } from '../diagnostics/nativeLogAdmission.js';
import { AGENT_RUN_ALIAS_LIMITS_ENV, agentRunAliasCeiling, parseAgentRunAliasLimits, type AgentRunAliasLimits } from './agentRunAliasLimits.js';
import { aliasCapacityWait, isAgentCapacityError, wakeAgentCapacityWaiters } from './agentCapacity.js';
import { ADMISSION_SCRIPT as SCRIPT } from './agentRunAdmissionScript.js';
import {
    AGENT_ADMISSION_MAX_NESTING_DEPTH, AGENT_RUN_NESTED_LIMIT_ENV, AgentAdmissionNestingError, DEFAULT_AGENT_RUN_NESTED_LIMIT,
    currentAgentAdmissionNesting, parseAgentRunNestedLimit, type AgentAdmissionNesting,
} from './agentRunNesting.js';

/** Fleet's existing server-side activation boundary is PROPR_FLEET_CONTROL_SECRET.
 * WORKER_CONCURRENCY is provisioned by Fleet, not the persisted UI setting.
 * Deliberately separate from #2989's per-worker CONFIG_REPO resolver. */
export interface AdmissionConfig {
    instance: string; limit: number; generation?: number;
    /** Per-direct-agent ceilings. Deliberately outside the fenced identity:
     * each acquire passes the current value, so changes need no drain. */
    aliasLimits?: AgentRunAliasLimits;
    /** Running nested executions one parent may carry (`PROPR_AGENT_RUN_NESTED_LIMIT`); absent = the default. */
    nestedLimit?: number;
}

export function resolveAgentRunAdmission(env: NodeJS.ProcessEnv = process.env): AdmissionConfig | null {
    const config = resolveGlobalAgentRunAdmission(env);
    const aliasLimits = parseAgentRunAliasLimits(env[AGENT_RUN_ALIAS_LIMITS_ENV], config?.limit ?? null);
    const nestedLimit = parseAgentRunNestedLimit(env[AGENT_RUN_NESTED_LIMIT_ENV]);
    if (nestedLimit !== undefined && !config) throw new Error(`${AGENT_RUN_NESTED_LIMIT_ENV} requires agent-run admission (PROPR_AGENT_RUN_LIMIT or the Hosted entitlement)`);
    if (!config) return null;
    return { ...config, ...(aliasLimits ? { aliasLimits } : {}), ...(nestedLimit !== undefined ? { nestedLimit } : {}) };
}

function resolveGlobalAgentRunAdmission(env: NodeJS.ProcessEnv): AdmissionConfig | null {
    const hosted = Boolean(env.PROPR_FLEET_CONTROL_SECRET);
    if (!hosted && env.PROPR_AGENT_RUN_LIMIT === undefined) return null;
    const raw = hosted ? env.WORKER_CONCURRENCY : env.PROPR_AGENT_RUN_LIMIT;
    const limit = raw?.trim() ? Number(raw) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || (hosted && ![2, 6, 12].includes(limit))) {
        throw new Error('Invalid physical agent-run entitlement; Hosted requires WORKER_CONCURRENCY=2, 6 or 12');
    }
    const instance = env.PROPR_INSTANCE_ID?.trim();
    if (!instance) throw new Error('Agent-run admission requires PROPR_INSTANCE_ID');
    const generation = env.PROPR_AGENT_RUN_GENERATION === undefined ? 0 : Number(env.PROPR_AGENT_RUN_GENERATION);
    if (!Number.isSafeInteger(generation) || generation < 0 || env.PROPR_AGENT_RUN_GENERATION?.trim() === '') {
        throw new Error('Invalid PROPR_AGENT_RUN_GENERATION; expected a nonnegative safe integer');
    }
    return generation ? { instance, limit, generation } : { instance, limit };
}


export interface AdmissionRedis {
    get(key: string): Promise<string | null>;
    eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
    hgetall(key: string): Promise<Record<string, string>>;
    zadd(key: string, score: number, member: string): Promise<unknown>;
    zrem(key: string, member: string): Promise<unknown>;
    zremrangebyscore(key: string, min: string, max: number): Promise<unknown>;
    zcard(key: string): Promise<number>;
}
export interface AdmissionDocker {
    daemon(): Promise<string>;
    assertEmpty(instance: string): Promise<void>;
    create(args: string[], env?: Record<string, string>, cwd?: string): Promise<string>;
    remove(id: string): Promise<void>;
}
const exec = promisify(execFile);
function admissionDocker(env: NodeJS.ProcessEnv, cwd?: string): AdmissionDocker {
    const execute = (args: string[], timeout: number) => exec('docker', args, { env, cwd, timeout, maxBuffer: 1024 * 1024 });
    return {
        async daemon() {
            const { stdout } = await execute(['info', '--format', '{{.ID}}'], 10_000);
            if (!stdout.trim()) throw new Error('Docker daemon identity unavailable');
            return stdout.trim();
        },
        async assertEmpty(instance) {
            const scope = createHash('sha256').update(instance).digest('hex');
            const { stdout } = await execute(['ps', '-aq', '--filter', `label=propr.agent-admission.instance=${scope}`], 10_000);
            if (stdout.trim()) throw new Error('Agent admission state missing while Docker containers survive; drain before recovery');
        },
        async create(args) {
            // execFile errors embed the full command, which can contain credentials.
            // Never propagate that error or its cause outside this boundary.
            const { stdout } = await execute(['create', ...args.slice(1)], 120_000).catch(() => { throw new Error('Docker could not create the admitted agent container; inspect the Docker daemon for details'); });
            const id = stdout.trim();
            if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker create returned no immutable container ID');
            return id;
        },
        async remove(id) {
            if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid admission container ID');
            // A successful daemon query, not an ambiguous CLI error, proves absence.
            const { stdout } = await execute(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`], 10_000);
            if (!stdout.split('\n').includes(id)) return;
            try { await execute(['rm', '-f', id], 30_000); }
            catch (error) {
                const check = await execute(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`], 10_000);
                if (check.stdout.split('\n').includes(id)) throw error;
            }
        },
    };
}

export function agentAdmissionKeys(instance: string): [string, string, string, string] {
    const scope = createHash('sha256').update(instance).digest('hex');
    return [`propr:agent-admission:{${scope}}:holders`, `propr:agent-admission:{${scope}}:config`, `propr:agent-admission:{${scope}}:waiting`, `propr:agent-admission:{${scope}}:parents`];
}

interface HolderRecord { state: 'reserved' | 'running' | 'draining' | 'recovering'; alias?: string; id?: string; parent?: string; depth?: number; shared?: boolean; scope?: string }
async function holderRecords(client: AdmissionRedis, instance: string): Promise<Array<[string, HolderRecord]>> {
    return Object.entries(await client.hgetall(agentAdmissionKeys(instance)[0])).map(([token, value]) => [token, JSON.parse(value) as HolderRecord]);
}

/** `nested` counts executions charged under a parent's reservation; each is
 * also counted in its own state. `draining` parents finished but keep their
 * slot until their nested executions end. */
export async function agentAdmissionMetrics(client: AdmissionRedis, instance: string) {
    const [, , waiting] = agentAdmissionKeys(instance);
    await client.zremrangebyscore(waiting, '-inf', Date.now());
    const counts = { waiting: await client.zcard(waiting), reserved: 0, running: 0, draining: 0, recovering: 0, nested: 0 };
    for (const [, record] of await holderRecords(client, instance)) {
        counts[record.state]++;
        if (record.parent) counts.nested++;
    }
    return counts;
}

/** Holder count per direct agent alias, every state included: a recovering
 * holder occupies its alias until removal is confirmed. Holders without an
 * alias (pre-upgrade records, exempt launches) appear under no alias. A nested
 * execution on its parent's alias is charged under the parent's slot and is
 * not counted here; see agentAdmissionNestedHolders. */
export async function agentAdmissionAliasHolders(client: AdmissionRedis, instance: string): Promise<Record<string, number>> {
    // A Map, so an alias such as `constructor` never reads an inherited property.
    const counts = new Map<string, number>();
    for (const [, { alias, shared }] of await holderRecords(client, instance)) {
        if (alias && !shared) counts.set(alias, (counts.get(alias) ?? 0) + 1);
    }
    return Object.fromEntries(counts);
}

export interface AgentAdmissionNestedHolder {
    /** First 8 characters of the parent's holder token (never the full token). */
    parent: string;
    parentAlias?: string;
    parentState: HolderRecord['state'] | 'missing';
    nested: Array<{ alias?: string; state: HolderRecord['state']; chargedUnderParent: boolean; containerId?: string }>;
}

/** Each parent holder with the nested executions charged under it, for diagnostics. */
export async function agentAdmissionNestedHolders(client: AdmissionRedis, instance: string): Promise<AgentAdmissionNestedHolder[]> {
    const records = new Map(await holderRecords(client, instance));
    const parents = new Map<string, AgentAdmissionNestedHolder>();
    for (const record of records.values()) {
        if (!record.parent) continue;
        const parent = records.get(record.parent);
        const entry = parents.get(record.parent) ?? { parent: record.parent.slice(0, 8), ...(parent?.alias ? { parentAlias: parent.alias } : {}), parentState: parent?.state ?? 'missing', nested: [] };
        parents.set(record.parent, entry);
        entry.nested.push({ ...(record.alias ? { alias: record.alias } : {}), state: record.state, chargedUnderParent: Boolean(record.shared), ...(record.id ? { containerId: record.id } : {}) });
    }
    return [...parents.values()];
}

/** Launches that have no registered direct agent and are deliberately
 * charged to the global limit only. Listed in the architecture doc. */
export type AgentAdmissionExemption = 'legacy-claude-analysis';

/** Why an acquire attempt did not admit: the global limit, the alias's own
 * ceiling, or a holder whose removal is still unconfirmed. */
export type AgentAdmissionWaitReason = 'global_limit' | 'alias_limit' | 'recovering';
const WAIT_REASONS: Record<number, AgentAdmissionWaitReason> = { 0: 'recovering', 2: 'global_limit', 3: 'alias_limit' };

export class AgentAdmissionIdentityError extends Error {
    constructor() {
        super('Agent admission cannot identify the direct agent for this launch; PROPR_AGENT_RUN_ALIAS_LIMITS requires every admitted launch to carry its agent alias');
        this.name = 'AgentAdmissionIdentityError';
    }
}

/** The alias charged for a launch ('' = global limit only) and its ceiling. */
export function resolveAdmissionAlias(config: AdmissionConfig, identity: { agentAlias?: string; exemption?: AgentAdmissionExemption }): { alias: string; ceiling: string; log: Record<string, string | number> } {
    const alias = identity.agentAlias?.trim() ?? '';
    if (!alias && !identity.exemption && config.aliasLimits) throw new AgentAdmissionIdentityError();
    const ceiling = agentRunAliasCeiling(config.aliasLimits, alias);
    const log = { ...(alias ? { agentAlias: alias } : {}), ...(ceiling === undefined ? {} : { aliasLimit: ceiling }) };
    return { alias, ceiling: ceiling === undefined ? '' : String(ceiling), log };
}

/** Maps a non-admitting acquire reply to its reason; logs and reports changes. */
function waitReasonReporter(instance: string, log: Record<string, string | number>, onWaiting?: (reason: AgentAdmissionWaitReason) => void) {
    let current: AgentAdmissionWaitReason | undefined;
    return (result: unknown) => {
        const reason = WAIT_REASONS[result as number];
        if (!reason) throw new Error('Unexpected agent admission reply');
        if (reason === current) return;
        current = reason;
        logger.info({ instance, ...log, reason }, 'Physical agent admission waiting');
        onWaiting?.(reason);
    };
}

export interface AdmissionOptions {
    /** Resolve time-sensitive arguments synchronously at the physical create boundary. */
    createArgs?: () => string[] | Promise<string[]>;
    signal?: AbortSignal;
    taskId?: string;
    /** Alias of the direct agent that runs (never a synthetic alias). */
    agentAlias?: string;
    /** A documented launch without a registered agent: global limit only. */
    exemption?: AgentAdmissionExemption;
    /** Observes each change of the reason an acquire is still waiting. */
    onWaiting?: (reason: AgentAdmissionWaitReason) => void;
    /**
     * A queue job that can defer: an alias-ceiling wait longer than this throws
     * AgentCapacityError instead of holding the worker. Defaults to the job's
     * capacity context (`runWithAgentCapacityContext`); unset keeps waiting.
     */
    capacityRaceWaitMs?: number;
    /** The abort reason that means the caller's own timeout expired (not a cancellation). */
    timeoutReason?: unknown;
    extraEnvVars?: Record<string, string>;
    cwd?: string;
    /** Infrastructure injection for real Redis tests; never sourced from request data. */
    client?: AdmissionRedis;
    docker?: AdmissionDocker;
    config?: AdmissionConfig;
    leaseMs?: number;
    pollMs?: number;
    /** Parent link for a nested execution. Defaults to the async context (`runWithAgentAdmissionParent`). */
    nesting?: AgentAdmissionNesting;
}
export interface AdmittedAgent {
    args: string[];
    environment: NodeJS.ProcessEnv;
    id: string;
    signal: AbortSignal;
    finish(): Promise<void>;
}

/** A capacity refusal is reported as itself; anything else as the cancellation that caused it, if any. */
function admissionFailure(error: unknown, signal: AbortSignal): unknown {
    return isAgentCapacityError(error) ? error : getExecutionAbortError(signal) ?? error;
}

function checkAdmissionAbort(signal: AbortSignal): void {
    const error = getExecutionAbortError(signal);
    if (error) throw error;
}

function createAdmissionClient(): Redis {
    const client = new Redis({
        host: process.env.REDIS_HOST || 'redis', port: Number(process.env.REDIS_PORT || 6379),
        connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1,
        retryStrategy: () => null,
    });
    client.on('error', error => logger.error({ error: error.message }, 'Agent admission Redis unavailable'));
    return client;
}

/** The nesting arguments of the admission script, and their log fields (scope kinds only: a goal nonce is never logged). */
function admissionNesting(options: AdmissionOptions, config: AdmissionConfig) {
    const nesting: AgentAdmissionNesting = options.nesting ?? currentAgentAdmissionNesting() ?? {};
    const nestedLimit = config.nestedLimit ?? DEFAULT_AGENT_RUN_NESTED_LIMIT;
    const kind = (scope: string | undefined) => scope?.split(':')[0];
    const log = Object.fromEntries(Object.entries({ parentScope: kind(nesting.parent), registersScope: kind(nesting.register) }).filter(([, value]) => value));
    return { args: [nesting.parent ?? '', nesting.register ?? '', String(AGENT_ADMISSION_MAX_NESTING_DEPTH), String(nestedLimit)], log, nestedLimit };
}

/** 'top' or 'nested' for an admitting acquire reply; throws beyond the nesting bounds (refused at once, never waited for). */
function admittedReply(result: unknown, nestedLimit: number): 'top' | 'nested' | null {
    if (result === 5) throw new AgentAdmissionNestingError('depth', AGENT_ADMISSION_MAX_NESTING_DEPTH);
    if (result === 6) throw new AgentAdmissionNestingError('count', nestedLimit);
    return result === 1 ? 'top' : result === 4 ? 'nested' : null;
}
const ADMITTED_MESSAGES: Record<string, string> = { true: 'Physical agent admitted as nested under its parent', false: 'Physical agent admitted' };

/** Acquire exactly once, at the physical Docker boundary, never at logical wrappers.
 * create -> fenced ID registration -> start ID makes crash recovery safe even
 * when a process resumes after its lease expired. Recovery removes that exact
 * container before freeing capacity; a late start of the removed ID fails. */
export async function prepareAdmittedAgent(args: string[], options: AdmissionOptions = {}): Promise<AdmittedAgent | null> {
    assertNativeLogAdmission(args);
    const config = options.config ?? resolveAgentRunAdmission();
    if (!config) return null;
    const { alias, ceiling, log } = resolveAdmissionAlias(config, options);
    const ownedClient = options.client ? undefined : createAdmissionClient();
    const client = options.client ?? ownedClient!;
    const environment = { ...process.env, ...options.extraEnvVars };
    const runtime = options.docker ?? admissionDocker(environment, options.cwd);
    const [holders, configKey, waiting, parents] = agentAdmissionKeys(config.instance);
    const { args: nestingArgs, log: nestingLog, nestedLimit } = admissionNesting(options, config);
    const token: string = randomUUID();
    const leaseMs = options.leaseMs ?? 30_000;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let id: string | undefined;
    let acquired = false;
    let nested = false;
    let timer: NodeJS.Timeout | undefined;
    let renewal: Promise<void> = Promise.resolve();
    let closed = false;
    const call = (op: string, owner = token, extra = '', limit = '') =>
        client.eval(SCRIPT, 3, holders, configKey, parents, op, owner, String(leaseMs), extra, limit, alias, ceiling,
            ...nestingArgs);
    const wake = (target: string) => {
        if (agentRunAliasCeiling(config.aliasLimits, target) === undefined) return;
        void wakeAgentCapacityWaiters(target, { config })
            .catch(error => logger.debug({ alias: target, error: String(error) }, 'Could not wake agent capacity waiters'));
    };
    // The last nested execution of a finished (draining) parent also hands the
    // parent's slot back: the reply names it, and it is removed and released here.
    const release = async (owner: string) => {
        let reply = await call('release', owner);
        while (Array.isArray(reply)) {
            const [, parentToken, parentId, parentAlias] = reply as [number, string, string, string];
            if (parentId) await runtime.remove(parentId);
            reply = await call('release', parentToken);
            if (parentAlias) wake(parentAlias);
        }
    };
    const checkCancelled = async () => {
        checkAdmissionAbort(signal);
        if (options.taskId && await checkAbortSignal(options.taskId, plannerAbortSignalKeyForTask(options.taskId))) {
            throw new ExecutionAbortedError();
        }
        checkAdmissionAbort(signal);
    };
    const recover = async (identity: string) => {
        const expired = await call('expired', token, identity) as string[];
        for (let i = 0; i < expired.length; i += 2) {
            if (expired[i + 1]) await runtime.remove(expired[i + 1]);
            await release(expired[i]);
        }
    };
    // Fence this owner, and with it every nested execution charged under it
    // (unless it finished normally while they run: then it is `draining`).
    // Containers are removed child first: physical nested work never outlives
    // its fenced parent, on local cleanup as on external recovery.
    const fenceAndStop = async () => {
        let coordinationError: unknown;
        let fenced: unknown;
        try { fenced = await call('fence'); } catch (error) { coordinationError = error; }
        const nestedHolders = Array.isArray(fenced) ? (fenced as string[]).slice(1) : [];
        for (let i = 0; i < nestedHolders.length; i += 2) {
            if (nestedHolders[i + 1]) await runtime.remove(nestedHolders[i + 1]);
        }
        if (id) await runtime.remove(id);
        return { draining: fenced === 2, nestedHolders, coordinationError };
    };
    const finish = async () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        await renewal;
        try {
            // Fence before removal: no future attach/renew can resurrect this owner.
            // Stop physical work even while Redis is unavailable. Retain the
            // reservation if either coordination or Docker removal failed.
            const { draining, nestedHolders, coordinationError } = acquired
                ? await fenceAndStop()
                : { draining: false, nestedHolders: [], coordinationError: undefined };
            if (!acquired && id) await runtime.remove(id);
            if (coordinationError) throw coordinationError;
            // Fenced nested executions are released before the parent they are charged under.
            if (acquired && !draining) {
                for (let i = 0; i < nestedHolders.length; i += 2) await release(nestedHolders[i]);
                await release(token);
            }
            await client.zrem(waiting, token);
            if (draining) logger.info({ instance: config.instance, containerId: id, ...log }, 'Physical agent finished; its reservation stays charged until its nested executions end');
            // Released capacity goes to the oldest job deferred for this alias.
            else if (acquired && ceiling) wake(alias);
        } finally { ownedClient?.disconnect(); }
    };
    const renew = () => {
        timer = setTimeout(() => {
            renewal = (async () => {
                try {
                    if (await call('renew') !== 1) {
                        const error = new Error('Agent admission ownership lost');
                        controller.abort(error);
                        // A lost lease fences this owner's nested executions too: stop
                        // them before this container even if the caller is suspended.
                        await fenceAndStop().catch(failure => logger.error({ error: String(failure) }, 'Agent admission stop failed'));
                        return;
                    }
                    if (!closed) renew();
                } catch (error) {
                    controller.abort(error);
                    // Redis loss never frees a slot. Stop the immutable ID even if
                    // the caller is suspended; a future acquirer will reconcile it.
                    if (id) await runtime.remove(id).catch(failure => logger.error({ error: String(failure) }, 'Agent admission stop failed'));
                }
            })();
        }, Math.max(10, Math.floor(leaseMs / 3)));
    };
    const initialize = async (identity: string) => {
        try { await runtime.assertEmpty(config.instance); }
        catch (error) {
            // Another process can initialize and launch between our
            // missing-config observation and Docker inspection.
            if (await client.get(configKey) === identity) return;
            throw error;
        }
        await call('initialize', token, identity);
    };
    try {
        await checkCancelled();
        const identity = JSON.stringify({ limit: config.limit, daemon: await runtime.daemon(), ...(config.generation ? { generation: config.generation } : {}) });
        await checkCancelled();
        logger.info({ instance: config.instance, limit: config.limit, ...log, ...nestingLog }, 'Waiting for physical agent admission');
        const reportWait = waitReasonReporter(config.instance, log, options.onWaiting);
        const aliasWait = aliasCapacityWait(alias, ceiling, options);
        try {
            while (true) {
                await client.zadd(waiting, Date.now() + 30_000, token);
                await recover(identity);
                await checkCancelled();
                const result = await call('acquire', token, identity, String(config.limit));
                const admitted = admittedReply(result, nestedLimit);
                if (admitted) { acquired = true; nested = admitted === 'nested'; break; }
                if (result === -1) {
                    await initialize(identity);
                    continue;
                }
                reportWait(result);
                aliasWait.observe(result);
                await aliasWait.pause(options.pollMs ?? 250, signal);
            }
        } catch (error) { throw aliasWait.failure(error, signal); }
        await client.zrem(waiting, token);
        renew();
        await checkCancelled();
        // No agent executes during create. Keep the caller's security, mounts,
        // names, environment and network policy arguments intact. Do not race or
        // abandon create on cancellation: collect its immutable ID (the Docker
        // call is separately bounded), then remove it without ever starting it.
        const createArgs = await options.createArgs?.() ?? args;
        assertNativeLogAdmission(createArgs);
        id = await runtime.create(['run', '--label', `propr.agent-admission.token=${token}`, '--label', `propr.agent-admission.instance=${createHash('sha256').update(config.instance).digest('hex')}`, ...createArgs.slice(1)], options.extraEnvVars, options.cwd);
        await checkCancelled();
        if (await call('attach', token, id) !== 1) throw new Error('Agent admission lost before container start');
        checkAdmissionAbort(signal);
        logger.info({ instance: config.instance, containerId: id, ...log, ...nestingLog, nestedUnderParent: nested, ...await agentAdmissionMetrics(client, config.instance) }, ADMITTED_MESSAGES[String(nested)]);
        return { id, args: ['start', '--attach', '--interactive', id], environment, signal, finish };
    } catch (error) {
        try { await finish(); }
        catch (cleanupError) { logger.error({ error: String(cleanupError) }, 'Agent admission retained for recovery'); }
        throw admissionFailure(error, signal);
    }
}

/** What the spawned `docker` command was derived from. `createArgs` are the
 * final, post-network-policy create arguments, kept separate because admission
 * replaces them with a container start command that carries none of them. */
export interface SpawnedAgentLaunch { createArgs: readonly string[]; environment?: NodeJS.ProcessEnv }

/** Native goal sessions use the same admission, retaining it until child close
 * and confirmed container removal. Network-policy setup remains outside this. */
export interface AgentAdmissionIdentity { agentAlias?: string; exemption?: AgentAdmissionExemption }

export async function spawnAdmittedAgent(args: string[], spawnChild: (args: string[], launch: SpawnedAgentLaunch) => ChildProcess, identity: AgentAdmissionIdentity = {}): Promise<ChildProcess> {
    const { getExecutionOwnershipContext } = await import('../claude/docker/dockerExecutionOwnership.js');
    const taskLabel = args.find(arg => arg.startsWith('propr.task.id='));
    const admission = await prepareAdmittedAgent(args, { signal: getExecutionOwnershipContext()?.signal, taskId: taskLabel?.slice('propr.task.id='.length), ...identity });
    if (!admission) return spawnChild(args, { createArgs: args });
    let child: ChildProcess;
    try { checkAdmissionAbort(admission.signal); child = spawnChild(admission.args, { createArgs: args, environment: admission.environment }); }
    catch (error) { await admission.finish(); throw error; }
    const stop = () => { child.kill('SIGKILL'); };
    admission.signal.addEventListener('abort', stop, { once: true });
    child.once('close', () => {
        admission.signal.removeEventListener('abort', stop);
        void admission.finish().catch(error => logger.error({ error: String(error) }, 'Native agent admission retained for recovery'));
    });
    return child;
}
