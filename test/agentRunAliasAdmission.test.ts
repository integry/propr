/**
 * Per-agent (alias) admission ceilings over a real Redis, with real
 * multi-process contention through both production Docker wrappers and a
 * Docker lifecycle simulator. Redis: a spawned `redis-server` when available
 * (PROPR_TEST_REDIS_SERVER), otherwise REDIS_HOST / REDIS_PORT (CI starts one
 * with scripts/ci-redis.sh). With PROPR_REQUIRE_REDIS_INTEGRATION=1, as CI
 * sets, an unavailable Redis fails the suite instead of skipping it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, spawnSync, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import {
    AgentAdmissionIdentityError, agentAdmissionAliasHolders, agentAdmissionKeys, agentAdmissionMetrics, prepareAdmittedAgent,
    resolveAgentRunAdmission, type AdmissionConfig, type AdmissionDocker, type AgentAdmissionWaitReason,
} from '../packages/core/src/agents/agentRunAdmission.js';
import { agentRunAliasLimitProblems, parseAgentRunAliasLimits } from '../packages/core/src/agents/agentRunAliasLimits.js';
import { validateAgentRunAdmissionPolicy } from '../packages/core/src/agents/agentRunAdmissionPolicy.js';

const required = process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1';
const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const run = randomUUID().slice(0, 8); // Instance keys are unique per run on a shared Redis.
let root: string, redis: Redis | undefined, server: ChildProcess | undefined, unavailable: string | undefined;
const children: ChildProcess[] = [];
const previous = { ...process.env };

async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>(resolve => probe.close(() => resolve()));
    return port;
}
async function connect(host: string, port: number, attempts: number): Promise<Redis | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const client = new Redis({ host, port, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1 });
        client.on('error', () => {});
        try { await client.connect(); await client.ping(); return client; }
        catch { client.disconnect(); await delay(100); }
    }
    return undefined;
}
async function startRedis(): Promise<{ host: string; port: number } | undefined> {
    if (spawnSync(binary, ['--version']).status === 0) {
        const port = await freePort();
        server = spawn(binary, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
        redis = await connect('127.0.0.1', port, 50);
        if (redis) return { host: '127.0.0.1', port };
    }
    if (process.env.REDIS_HOST || process.env.REDIS_PORT) {
        const host = process.env.REDIS_HOST || '127.0.0.1', port = Number(process.env.REDIS_PORT || 6379);
        redis = await connect(host, port, 3);
        if (redis) return { host, port };
    }
    return undefined;
}

// Resolved before tests register, so skip options reflect real availability.
const endpoint = await startRedis();
if (!endpoint) unavailable = `no ${binary} binary and no reachable REDIS_HOST/REDIS_PORT`;

before(async () => {
    if (!endpoint) {
        if (required) throw new Error(`Redis integration tests are required (PROPR_REQUIRE_REDIS_INTEGRATION=1) but ${unavailable}`);
        return;
    }
    root = await mkdtemp(path.join(tmpdir(), 'agent-alias-admission-'));
    const bin = path.join(root, 'bin'); await mkdir(bin);
    await writeFile(path.join(bin, 'docker'), `#!${process.execPath}\n${await readFile('test/fixtures/agent-admission/docker.mjs', 'utf8')}`);
    await chmod(path.join(bin, 'docker'), 0o755);
    Object.assign(process.env, { REDIS_HOST: endpoint.host, REDIS_PORT: String(endpoint.port), PATH: `${bin}:${process.env.PATH}`, PROPR_DEMO_MODE: 'true' });
});
after(async () => {
    for (const child of children) child.kill('SIGKILL');
    if (redis) {
        // Shared Redis: delete only this run's keys.
        for (const name of instances) await redis.del(...agentAdmissionKeys(name));
        redis.disconnect();
    }
    server?.kill('SIGTERM');
    // The configuration import graph opens the database pool; its reaper
    // interval would otherwise keep this file alive until the unit timeout.
    await (await import('../packages/core/src/db/connection.js')).closeConnection();
    if (root) await rm(root, { force: true, recursive: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
});
const integration = () => ({ skip: unavailable ? `Redis required: ${unavailable}` : false, timeout: 90_000 });
const instances: string[] = [];
const instance = (name: string) => { const id = `alias-${run}-${name}`; instances.push(id); return id; };
const client = () => redis!;

async function until(check: () => Promise<boolean>, timeout = 15_000) {
    const end = Date.now() + timeout;
    while (!await check()) { if (Date.now() > end) assert.fail('Timed out'); await delay(20); }
}
function lifecycle() {
    let count = 0;
    const alive = new Set<string>();
    const runtime: AdmissionDocker = {
        daemon: async () => 'test',
        assertEmpty: async () => {},
        create: async () => { const id = `container-${++count}`; alive.add(id); return id; },
        remove: async id => { alive.delete(id); },
    };
    return { runtime, alive };
}
const holderRecords = async (name: string) => Object.entries(await client().hgetall(agentAdmissionKeys(name)[0])).map(([token, value]) => ({ token, ...JSON.parse(value) }));
/** Starts an admission that is expected to wait; resolves its first wait reason. */
function waiting(args: Parameters<typeof prepareAdmittedAgent>[1]) {
    const controller = new AbortController();
    let reported!: (reason: AgentAdmissionWaitReason) => void;
    const reason = new Promise<AgentAdmissionWaitReason>(resolve => { reported = resolve; });
    const reasons: AgentAdmissionWaitReason[] = [];
    const admission = prepareAdmittedAgent(['run', 'agent'], { ...args, signal: controller.signal, pollMs: 10, onWaiting: value => { reasons.push(value); reported(value); } });
    void admission.catch(() => {});
    return { admission, reason, reasons, cancel: () => controller.abort(new Error('waiter cancelled')) };
}

test('policy parsing: format, ceilings above the global limit, admission off, unset', () => {
    const self = { PROPR_AGENT_RUN_LIMIT: '4', PROPR_INSTANCE_ID: 'self' };
    assert.deepEqual(resolveAgentRunAdmission({ ...self, PROPR_AGENT_RUN_ALIAS_LIMITS: ' local-llama=1 , claude-prod=4' }), { instance: 'self', limit: 4, aliasLimits: { 'local-llama': 1, 'claude-prod': 4 } });
    for (const unset of [undefined, '', '  ']) {
        assert.deepEqual(resolveAgentRunAdmission({ ...self, PROPR_AGENT_RUN_ALIAS_LIMITS: unset }), { instance: 'self', limit: 4 }, 'unset keeps the existing configuration shape');
    }
    for (const malformed of ['local', 'local=', '=1', 'local=0', 'local=-1', 'local=1.5', 'local=one', 'Local=1', 'a b=1', 'local=1,', '{"local":1}', 'local=1,local=1']) {
        assert.throws(() => resolveAgentRunAdmission({ ...self, PROPR_AGENT_RUN_ALIAS_LIMITS: malformed }), /PROPR_AGENT_RUN_ALIAS_LIMITS/, malformed);
    }
    assert.throws(() => resolveAgentRunAdmission({ ...self, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=5' }), /exceeds the global agent-run limit 4/);
    // Hosted: the entitlement is the global limit a ceiling must fit inside.
    const hosted = { PROPR_FLEET_CONTROL_SECRET: 'configured', PROPR_INSTANCE_ID: 'fleet', WORKER_CONCURRENCY: '2' };
    assert.deepEqual(resolveAgentRunAdmission({ ...hosted, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=2' })?.aliasLimits, { local: 2 });
    assert.throws(() => resolveAgentRunAdmission({ ...hosted, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=3' }), /exceeds/);
    // Admission off: a per-alias policy is an error, never a silent no-op.
    assert.throws(() => resolveAgentRunAdmission({ PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=1' }), /require agent-run admission/);
    assert.equal(resolveAgentRunAdmission({}), null);
    assert.equal(parseAgentRunAliasLimits(undefined, null), undefined);
});

test('policy validation rejects synthetic and unknown aliases at startup', async () => {
    const inventory = { directAliases: ['local-llama', 'claude-prod', 'disabled-agent'], syntheticAliases: ['pool'] };
    assert.deepEqual(agentRunAliasLimitProblems({ 'local-llama': 1, 'disabled-agent': 1 }, inventory), []);
    assert.match(agentRunAliasLimitProblems({ pool: 1 }, inventory).join(), /synthetic agent/);
    assert.match(agentRunAliasLimitProblems({ missing: 1 }, inventory).join(), /'missing' is not a configured direct agent/);
    assert.deepEqual(agentRunAliasLimitProblems({ default: 1 }, { directAliases: [], syntheticAliases: [] }), [], 'implicit default agent');
    assert.match(agentRunAliasLimitProblems({ default: 1 }, inventory).join(), /not a configured direct agent/);
    const env = { PROPR_AGENT_RUN_LIMIT: '2', PROPR_INSTANCE_ID: 'self', PROPR_AGENT_RUN_ALIAS_LIMITS: 'local-llama=1,pool=1' };
    await assert.rejects(validateAgentRunAdmissionPolicy({ env, loadInventory: async () => inventory }), /PROPR_AGENT_RUN_ALIAS_LIMITS: 'pool' is a synthetic agent/);
    await validateAgentRunAdmissionPolicy({ env: { ...env, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local-llama=1' }, loadInventory: async () => inventory });
    await assert.rejects(validateAgentRunAdmissionPolicy({ env: { PROPR_AGENT_RUN_ALIAS_LIMITS: 'local-llama=1' }, loadInventory: async () => inventory }), /require agent-run admission/);
    let loaded = false;
    await validateAgentRunAdmissionPolicy({ env: {}, loadInventory: async () => { loaded = true; return inventory; } });
    assert.equal(loaded, false, 'no policy: nothing to validate');
});

test('global and alias ceilings are distinct wait reasons; another alias is still admitted', integration(), async () => {
    const { runtime } = lifecycle();
    const name = instance('reasons');
    const config: AdmissionConfig = { instance: name, limit: 3, aliasLimits: { local: 1 } };
    const options = { client: client(), docker: runtime, config };
    const local = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'local' });
    const second = waiting({ ...options, agentAlias: 'local' });
    assert.equal(await second.reason, 'alias_limit');
    const clouds = [await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'cloud' }), await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'cloud' })];
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1, cloud: 2 });
    const third = waiting({ ...options, agentAlias: 'cloud' });
    assert.equal(await third.reason, 'global_limit');
    await clouds[0]!.finish();
    // The freed global slot goes to the cloud waiter, never to the capped alias.
    const admitted = await third.admission;
    await delay(50);
    assert.equal((await agentAdmissionAliasHolders(client(), name)).local, 1);
    await local!.finish();
    const next = await second.admission;
    assert.ok(second.reasons.includes('global_limit'), 'a full instance is reported as the global limit');
    assert.ok(second.reasons.every((reason, i) => reason !== second.reasons[i - 1]), 'only changes of reason are reported');
    for (const holder of [next, admitted, clouds[1]]) await holder!.finish();
    assert.equal(await client().hlen(agentAdmissionKeys(name)[0]), 0);
});

test('a configured policy refuses launches whose direct agent is unknown; exemptions are global-only', integration(), async () => {
    const { runtime } = lifecycle();
    const name = instance('identity');
    const config: AdmissionConfig = { instance: name, limit: 2, aliasLimits: { local: 1 } };
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config }), AgentAdmissionIdentityError);
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config, agentAlias: ' ' }), /cannot identify the direct agent/);
    assert.equal(await client().exists(...agentAdmissionKeys(name)), 0, 'refused before touching Redis');
    const exempt = await prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config, exemption: 'legacy-claude-analysis' });
    const local = await prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config, agentAlias: 'local' });
    assert.deepEqual((await holderRecords(name)).map(record => record.alias ?? null).sort(), ['local', null]);
    const blocked = waiting({ client: client(), docker: runtime, config, exemption: 'legacy-claude-analysis' });
    assert.equal(await blocked.reason, 'global_limit', 'exempt launches still need a global slot');
    blocked.cancel(); await assert.rejects(blocked.admission, /waiter cancelled/);
    await exempt!.finish(); await local!.finish();
});

test('unset policy: same decisions and holder data, plus only the alias field', integration(), async () => {
    const { runtime } = lifecycle();
    const name = instance('unset');
    const config = resolveAgentRunAdmission({ PROPR_AGENT_RUN_LIMIT: '1', PROPR_INSTANCE_ID: name })!;
    assert.equal(config.aliasLimits, undefined);
    const anonymous = await prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config });
    const [record] = await holderRecords(name);
    assert.deepEqual(Object.keys(record).sort(), ['deadline', 'id', 'state', 'token']);
    const blocked = waiting({ client: client(), docker: runtime, config, agentAlias: 'local' });
    assert.equal(await blocked.reason, 'global_limit');
    await anonymous!.finish();
    const named = await blocked.admission;
    const [aliased] = await holderRecords(name);
    assert.deepEqual(Object.keys(aliased).sort(), ['alias', 'deadline', 'id', 'state', 'token']);
    assert.equal(aliased.alias, 'local');
    assert.equal(await client().get(agentAdmissionKeys(name)[1]), JSON.stringify({ limit: 1, daemon: 'test' }), 'fenced identity carries no alias data');
    await named!.finish();
});

test('changing a ceiling between acquires takes effect without a generation change or drain', integration(), async () => {
    const { runtime, alive } = lifecycle();
    const name = instance('resize');
    const options = (local: number) => ({ client: client(), docker: runtime, agentAlias: 'local', config: { instance: name, limit: 4, aliasLimits: { local } } });
    const first = await prepareAdmittedAgent(['run', 'agent'], options(1));
    const identity = await client().get(agentAdmissionKeys(name)[1]);
    const raised = await prepareAdmittedAgent(['run', 'agent'], options(2));
    const over = waiting(options(2));
    assert.equal(await over.reason, 'alias_limit');
    over.cancel(); await assert.rejects(over.admission);
    // Lowering stops new admissions but never strands or stops running work.
    const lowered = waiting(options(1));
    assert.equal(await lowered.reason, 'alias_limit');
    assert.equal(alive.size, 2);
    assert.equal((await agentAdmissionMetrics(client(), name)).running, 2);
    await first!.finish();
    await delay(60);
    assert.equal(alive.size, 1, 'one remaining holder still fills the lowered ceiling');
    await raised!.finish();
    const admitted = await lowered.admission;
    assert.equal(await client().get(agentAdmissionKeys(name)[1]), identity, 'no generation bump, no configuration change');
    // No ceiling at all: global limit only.
    const unlimited = await Promise.all([1, 2, 3].map(() => prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, agentAlias: 'local', config: { instance: name, limit: 4 } })));
    assert.equal(alive.size, 4);
    for (const holder of [admitted, ...unlimited]) await holder!.finish();
});

test('waiting cancellation, create failure and repeated finish neither leak nor reuse alias capacity', integration(), async () => {
    const { runtime, alive } = lifecycle();
    const name = instance('leaks');
    const config: AdmissionConfig = { instance: name, limit: 3, aliasLimits: { local: 1 } };
    const options = { client: client(), docker: runtime, config, agentAlias: 'local' };
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, docker: { ...runtime, create: async () => { throw new Error('create failed'); } } }), /create failed/);
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), {}, 'create failure releases its alias reservation');
    const holder = await prepareAdmittedAgent(['run', 'agent'], options);
    const cancelled = waiting(options);
    assert.equal(await cancelled.reason, 'alias_limit');
    cancelled.cancel(); await assert.rejects(cancelled.admission, /waiter cancelled/);
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1 }, 'a cancelled waiter held nothing');
    assert.equal((await agentAdmissionMetrics(client(), name)).waiting, 0);
    // Repeated delivery of the same task: each physical launch needs its own slot.
    const duplicate = waiting(options);
    assert.equal(await duplicate.reason, 'alias_limit');
    await holder!.finish();
    const replacement = await duplicate.admission;
    await holder!.finish(); // A stale/repeated release cannot free the replacement's alias slot.
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1 });
    const again = waiting(options);
    assert.equal(await again.reason, 'alias_limit');
    again.cancel(); await assert.rejects(again.admission);
    await replacement!.finish();
    assert.equal(alive.size, 0);
    assert.equal(await client().hlen(agentAdmissionKeys(name)[0]), 0);
});

test('crashed or lease-lost alias holders keep counting until removal is confirmed', integration(), async () => {
    const { runtime, alive } = lifecycle();
    const name = instance('recovery');
    const [holders, configKey] = agentAdmissionKeys(name);
    const config: AdmissionConfig = { instance: name, limit: 2, aliasLimits: { local: 1 } };
    // A holder process crashed: its record outlives it with the alias it was charged to.
    await client().set(configKey, JSON.stringify({ limit: 2, daemon: 'test' }));
    alive.add('crashed');
    await client().hset(holders, 'dead-owner', JSON.stringify({ state: 'running', deadline: 0, id: 'crashed', alias: 'local' }));
    const failing = { ...runtime, remove: async () => { throw new Error('Docker unavailable'); } };
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: failing, config, agentAlias: 'cloud' }), /Docker unavailable/);
    const [record] = await holderRecords(name);
    assert.equal(record.state, 'recovering');
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1 }, 'unconfirmed removal keeps the alias charged');
    // Another process owns that removal: skip our own recovery pass, so acquire
    // itself observes the recovering holder.
    const othersRecover = { ...client(), get: client().get.bind(client()), hgetall: client().hgetall.bind(client()), zadd: client().zadd.bind(client()), zrem: client().zrem.bind(client()),
        zremrangebyscore: client().zremrangebyscore.bind(client()), zcard: client().zcard.bind(client()),
        eval: (script: string, keys: number, ...args: (string | number)[]) => args[2] === 'expired' ? Promise.resolve([]) : client().eval(script, keys, ...args) };
    const blocked = waiting({ client: othersRecover, docker: runtime, config, agentAlias: 'cloud' });
    assert.equal(await blocked.reason, 'recovering');
    blocked.cancel(); await assert.rejects(blocked.admission);
    const replacement = await prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config, agentAlias: 'local' });
    assert.equal(alive.has('crashed'), false, 'old execution removed before its alias slot is reused');
    await replacement!.finish();

    // Lease loss: renewal fails, the container is stopped, but the slot is retained.
    const connection = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT), retryStrategy: () => null });
    connection.on('error', () => {});
    const lost = await prepareAdmittedAgent(['run', 'agent'], { client: connection, docker: runtime, config, agentAlias: 'local', leaseMs: 3000 });
    connection.disconnect();
    await until(async () => lost!.signal.aborted && alive.size === 0);
    await assert.rejects(lost!.finish());
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1 });
    const early = waiting({ client: client(), docker: runtime, config, agentAlias: 'local' });
    assert.equal(await early.reason, 'alias_limit', 'not reusable before the lease expires');
    early.cancel(); await assert.rejects(early.admission);
    // Advance only the persisted deadline instead of sleeping out the lease.
    const [stale] = await holderRecords(name);
    const { token: staleToken, ...staleValue } = stale;
    await client().hset(holders, staleToken, JSON.stringify({ ...staleValue, deadline: 0 }));
    const recovered = await prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config, agentAlias: 'local' });
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1 });
    await recovered!.finish();
});

test('holder records written before the upgrade count toward the global limit only', integration(), async () => {
    const { runtime } = lifecycle();
    const name = instance('legacy');
    const [holders, configKey] = agentAdmissionKeys(name);
    await client().set(configKey, JSON.stringify({ limit: 2, daemon: 'test' }));
    // Pre-upgrade record shape: no alias field.
    await client().hset(holders, 'old-owner', JSON.stringify({ state: 'running', deadline: Date.now() + 60_000, id: 'old-container' }));
    const config: AdmissionConfig = { instance: name, limit: 2, aliasLimits: { local: 1 } };
    const local = await prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: runtime, config, agentAlias: 'local' });
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1 });
    const blocked = waiting({ client: client(), docker: runtime, config, agentAlias: 'cloud' });
    assert.equal(await blocked.reason, 'global_limit', 'the old record still fills a global slot');
    // Expiry and recovery of an alias-less record proceed without error.
    const value = JSON.parse((await client().hget(holders, 'old-owner'))!);
    await client().hset(holders, 'old-owner', JSON.stringify({ ...value, deadline: 0 }));
    const cloud = await blocked.admission;
    assert.equal(await client().hexists(holders, 'old-owner'), 0);
    await local!.finish(); await cloud!.finish();
});

async function writeRecord(directory: string, record: { id: string }) {
    const target = path.join(directory, `${record.id}.json`);
    await writeFile(target + '.tmp', JSON.stringify(record));
    await rename(target + '.tmp', target);
}
async function readRecords(directory: string) {
    const values = await Promise.all((await readdir(directory)).filter(f => f.endsWith('.json')).map(async file => {
        try { return JSON.parse(await readFile(path.join(directory, file), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
    return values.filter(Boolean);
}

test('both ceilings hold under multi-process contention across standard and native entrypoints', integration(), async () => {
    const directory = path.join(root, 'contention'); await mkdir(directory);
    const name = instance('contention');
    const env = { ...process.env, PROPR_INSTANCE_ID: name, PROPR_AGENT_RUN_LIMIT: '4', PROPR_AGENT_RUN_ALIAS_LIMITS: 'slow=1,fast=3', PROPR_TEST_ADMISSION_DOCKER: directory };
    delete env.PROPR_FLEET_CONTROL_SECRET;
    const launch = (alias: string, kind: string) => {
        const child = fork(path.resolve('test/fixtures/agent-admission/worker.ts'), [kind], { env: { ...env, PROPR_TEST_AGENT_ALIAS: alias }, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
        const done = new Promise<void>((resolve, reject) => {
            child.on('message', message => { if (typeof message === 'object') reject(new Error(JSON.stringify(message))); });
            child.on('exit', code => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}: ${stderr}`)));
        });
        void done.catch(() => {}).finally(() => { exited++; });
        children.push(child); return done;
    };
    let exited = 0;
    const aliasOf = async () => new Map((await holderRecords(name)).filter(r => r.id).map(r => [r.id as string, r.alias as string]));
    let violation = '';
    let sampling = true;
    const sampler = (async () => {
        while (sampling) {
            const counts = await agentAdmissionAliasHolders(client(), name);
            const total = await client().hlen(agentAdmissionKeys(name)[0]);
            if ((counts.slow ?? 0) > 1 || (counts.fast ?? 0) > 3 || total > 4) violation ||= JSON.stringify({ counts, total });
            await delay(5);
        }
    })();
    try {
        const slow = ['standard', 'native', 'standard'].map(kind => launch('slow', kind));
        await until(async () => (await readRecords(directory)).filter(r => r.state === 'running').length === 1, 40_000);
        await until(async () => (await agentAdmissionMetrics(client(), name)).waiting === 2, 40_000);
        assert.equal((await readRecords(directory)).length, 1, 'waiting slow launches cannot even create a container');
        // The saturated alias does not stop another alias from using free global capacity.
        const fast = ['native', 'standard', 'standard', 'native'].map(kind => launch('fast', kind));
        await until(async () => (await readRecords(directory)).filter(r => r.state === 'running').length === 4, 40_000);
        await until(async () => (await agentAdmissionMetrics(client(), name)).waiting === 3, 40_000);
        assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { slow: 1, fast: 3 });
        // Release the running slow holder: exactly one slow waiter replaces it.
        const owners = await aliasOf();
        const [slowRecord] = (await readRecords(directory)).filter(r => owners.get(r.id) === 'slow');
        await writeRecord(directory, { ...slowRecord, stop: true });
        await until(async () => { const now = await aliasOf(); return [...now.values()].filter(a => a === 'slow').length === 1 && !now.has(slowRecord.id); }, 40_000);
        await until(async () => (await readRecords(directory)).filter(r => r.state === 'running').length === 4, 40_000);
        // Drain everything until every launcher exits; capacity is handed over
        // one release at a time (a waiter can be between acquire and create).
        while (exited < slow.length + fast.length) {
            const records = await readRecords(directory);
            for (const record of records) if (record.state === 'running' && !record.stop) await writeRecord(directory, { ...record, stop: true });
            await delay(50);
        }
        await Promise.all([...slow, ...fast]);
        await until(async () => await client().hlen(agentAdmissionKeys(name)[0]) === 0);
    } finally {
        sampling = false; await sampler;
    }
    assert.equal(violation, '', `a ceiling was exceeded: ${violation}`);
    const starts = (await readFile(path.join(directory, 'starts'), 'utf8')).trim().split('\n');
    assert.equal(starts.length, 7, 'every launch ran exactly once');
});
