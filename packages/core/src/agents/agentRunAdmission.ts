import { randomUUID, createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { checkAbortSignal, plannerAbortSignalKeyForTask } from '../claude/docker/dockerAbortController.js';
import { ExecutionAbortedError, getExecutionAbortError } from '../claude/docker/dockerExecutionOwnership.js';
import { assertNativeLogAdmission } from '../diagnostics/nativeLogAdmission.js';

/** Fleet's existing server-side activation boundary is PROPR_FLEET_CONTROL_SECRET.
 * WORKER_CONCURRENCY is provisioned by Fleet, not the persisted UI setting.
 * Deliberately separate from #2989's per-worker CONFIG_REPO resolver. */
export interface AdmissionConfig { instance: string; limit: number; generation?: number }

export function resolveAgentRunAdmission(env: NodeJS.ProcessEnv = process.env): AdmissionConfig | null {
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

// Records NEVER expire. Expiry permits fencing and Docker removal, not reuse.
// All clock comparisons use Redis TIME. Each reservation has a unique token.
const SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local op, token = ARGV[1], ARGV[2]
if op == 'acquire' then
  local config = redis.call('GET', KEYS[2])
  if not config then return -1 end
  if config ~= ARGV[4] then return redis.error_reply('Agent admission configuration/daemon mismatch; drain before reconfiguration') end
  local all = redis.call('HVALS', KEYS[1])
  for _,value in ipairs(all) do
    if cjson.decode(value).state == 'recovering' then return 0 end
  end
  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end
  redis.call('HSET', KEYS[1], token, cjson.encode({deadline=now+tonumber(ARGV[3]), state='reserved'}))
  return 1
end
if op == 'initialize' then
  return redis.call('SET', KEYS[2], ARGV[4], 'NX')
end
if op == 'expired' then
  local config = redis.call('GET', KEYS[2])
  if config and config ~= ARGV[4] then
    local old, next = cjson.decode(config), cjson.decode(ARGV[4])
    if old.daemon ~= next.daemon or (next.generation or 0) <= (old.generation or 0) then
      return redis.error_reply('Agent admission configuration/daemon mismatch; stale generation or unsupported daemon change')
    end
    -- The new operator generation fences every reservation atomically with the
    -- config change. No capacity is reusable until removal is confirmed below.
    local all = redis.call('HGETALL', KEYS[1])
    for i=1,#all,2 do
      local r = cjson.decode(all[i+1]); r.state = 'recovering'
      redis.call('HSET', KEYS[1], all[i], cjson.encode(r))
    end
    redis.call('SET', KEYS[2], ARGV[4])
  end
  if not config and redis.call('HLEN', KEYS[1]) > 0 then return redis.error_reply('Agent admission configuration missing; drain before recovery') end
  local result = {}
  local all = redis.call('HGETALL', KEYS[1])
  for i=1,#all,2 do
    local r = cjson.decode(all[i+1])
    if r.deadline <= now or r.state == 'recovering' then
      r.state = 'recovering'
      redis.call('HSET', KEYS[1], all[i], cjson.encode(r))
      table.insert(result, all[i]); table.insert(result, r.id or '')
    end
  end
  return result
end
local value = redis.call('HGET', KEYS[1], token)
if not value then return 0 end
local r = cjson.decode(value)
if op == 'release' then
  if r.state ~= 'recovering' then return 0 end
  return redis.call('HDEL', KEYS[1], token)
end
if op == 'fence' then
  r.state = 'recovering'
elseif r.state == 'recovering' or r.deadline <= now then
  return 0
elseif op == 'attach' then
  if r.id then return 0 end
  r.id = ARGV[4]; r.state = 'running'
elseif op ~= 'renew' then
  return redis.error_reply('Unknown admission operation')
end
r.deadline = now + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], token, cjson.encode(r))
return 1
`;

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

export function agentAdmissionKeys(instance: string): [string, string, string] {
    const scope = createHash('sha256').update(instance).digest('hex');
    return [`propr:agent-admission:{${scope}}:holders`, `propr:agent-admission:{${scope}}:config`, `propr:agent-admission:{${scope}}:waiting`];
}

export async function agentAdmissionMetrics(client: AdmissionRedis, instance: string) {
    const [holders, , waiting] = agentAdmissionKeys(instance);
    await client.zremrangebyscore(waiting, '-inf', Date.now());
    const counts = { waiting: await client.zcard(waiting), reserved: 0, running: 0, recovering: 0 };
    for (const value of Object.values(await client.hgetall(holders))) {
        const record = JSON.parse(value) as { state: 'reserved' | 'running' | 'recovering' };
        counts[record.state]++;
    }
    return counts;
}

export interface AdmissionOptions {
    /** Resolve time-sensitive arguments synchronously at the physical create boundary. */
    createArgs?: () => string[];
    signal?: AbortSignal;
    taskId?: string;
    extraEnvVars?: Record<string, string>;
    cwd?: string;
    /** Infrastructure injection for real Redis tests; never sourced from request data. */
    client?: AdmissionRedis;
    docker?: AdmissionDocker;
    config?: AdmissionConfig;
    leaseMs?: number;
    pollMs?: number;
}
export interface AdmittedAgent {
    args: string[];
    environment: NodeJS.ProcessEnv;
    id: string;
    signal: AbortSignal;
    finish(): Promise<void>;
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

/** Acquire exactly once, at the physical Docker boundary, never at logical wrappers.
 * create -> fenced ID registration -> start ID makes crash recovery safe even
 * when a process resumes after its lease expired. Recovery removes that exact
 * container before freeing capacity; a late start of the removed ID fails. */
export async function prepareAdmittedAgent(args: string[], options: AdmissionOptions = {}): Promise<AdmittedAgent | null> {
    assertNativeLogAdmission(args);
    const config = options.config ?? resolveAgentRunAdmission();
    if (!config) return null;
    const ownedClient = options.client ? undefined : createAdmissionClient();
    const client = options.client ?? ownedClient!;
    const environment = { ...process.env, ...options.extraEnvVars };
    const runtime = options.docker ?? admissionDocker(environment, options.cwd);
    const [holders, configKey, waiting] = agentAdmissionKeys(config.instance);
    const token: string = randomUUID();
    const leaseMs = options.leaseMs ?? 30_000;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let id: string | undefined;
    let acquired = false;
    let timer: NodeJS.Timeout | undefined;
    let renewal: Promise<void> = Promise.resolve();
    let closed = false;
    const call = (op: string, owner = token, extra = '', limit = '') =>
        client.eval(SCRIPT, 2, holders, configKey, op, owner, String(leaseMs), extra, limit);
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
            await call('release', expired[i]);
        }
    };
    const finish = async () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        await renewal;
        try {
            // Fence before removal: no future attach/renew can resurrect this owner.
            let coordinationError: unknown;
            if (acquired) {
                try { await call('fence'); } catch (error) { coordinationError = error; }
            }
            // Stop physical work even while Redis is unavailable. Retain the
            // reservation if either coordination or Docker removal failed.
            if (id) await runtime.remove(id);
            if (coordinationError) throw coordinationError;
            if (acquired) await call('release');
            await client.zrem(waiting, token);
        } finally { ownedClient?.disconnect(); }
    };
    const renew = () => {
        timer = setTimeout(() => {
            renewal = (async () => {
                try {
                    if (await call('renew') !== 1) throw new Error('Agent admission ownership lost');
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
        logger.info({ instance: config.instance, limit: config.limit }, 'Waiting for physical agent admission');
        while (true) {
            await client.zadd(waiting, Date.now() + 30_000, token);
            await recover(identity);
            await checkCancelled();
            const result = await call('acquire', token, identity, String(config.limit));
            if (result === 1) { acquired = true; break; }
            if (result === -1) {
                await initialize(identity);
                continue;
            }
            await delay(options.pollMs ?? 250, undefined, { signal });
        }
        await client.zrem(waiting, token);
        renew();
        await checkCancelled();
        // No agent executes during create. Keep the caller's security, mounts,
        // names, environment and network policy arguments intact. Do not race or
        // abandon create on cancellation: collect its immutable ID (the Docker
        // call is separately bounded), then remove it without ever starting it.
        const createArgs = options.createArgs?.() ?? args;
        assertNativeLogAdmission(createArgs);
        id = await runtime.create(['run', '--label', `propr.agent-admission.token=${token}`, '--label', `propr.agent-admission.instance=${createHash('sha256').update(config.instance).digest('hex')}`, ...createArgs.slice(1)], options.extraEnvVars, options.cwd);
        await checkCancelled();
        if (await call('attach', token, id) !== 1) throw new Error('Agent admission lost before container start');
        checkAdmissionAbort(signal);
        logger.info({ instance: config.instance, containerId: id, ...await agentAdmissionMetrics(client, config.instance) }, 'Physical agent admitted');
        return { id, args: ['start', '--attach', '--interactive', id], environment, signal, finish };
    } catch (error) {
        try { await finish(); }
        catch (cleanupError) { logger.error({ error: String(cleanupError) }, 'Agent admission retained for recovery'); }
        throw getExecutionAbortError(signal) ?? error;
    }
}

/** Native goal sessions use the same admission, retaining it until child close
 * and confirmed container removal. Network-policy setup remains outside this. */
export async function spawnAdmittedAgent(args: string[], spawnChild: (args: string[]) => ChildProcess): Promise<ChildProcess> {
    const { getExecutionOwnershipContext } = await import('../claude/docker/dockerExecutionOwnership.js');
    const taskLabel = args.find(arg => arg.startsWith('propr.task.id='));
    const admission = await prepareAdmittedAgent(args, { signal: getExecutionOwnershipContext()?.signal, taskId: taskLabel?.slice('propr.task.id='.length) });
    if (!admission) return spawnChild(args);
    let child: ChildProcess;
    try { checkAdmissionAbort(admission.signal); child = spawnChild(admission.args); }
    catch (error) { await admission.finish(); throw error; }
    const stop = () => { child.kill('SIGKILL'); };
    admission.signal.addEventListener('abort', stop, { once: true });
    child.once('close', () => {
        admission.signal.removeEventListener('abort', stop);
        void admission.finish().catch(error => logger.error({ error: String(error) }, 'Native agent admission retained for recovery'));
    });
    return child;
}
