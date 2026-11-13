/**
 * Nested agent executions (#3480) over a real Redis, with real multi-process
 * contention through both production Docker wrappers and the Docker lifecycle
 * simulator. Redis: a spawned `redis-server` when available
 * (PROPR_TEST_REDIS_SERVER), otherwise REDIS_HOST / REDIS_PORT. With
 * PROPR_REQUIRE_REDIS_INTEGRATION=1, as CI sets, an unavailable Redis fails the
 * suite instead of skipping it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, spawnSync, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import {
    agentAdmissionAliasHolders, agentAdmissionKeys, agentAdmissionMetrics, agentAdmissionNestedHolders, prepareAdmittedAgent,
    resolveAgentRunAdmission, type AdmissionConfig, type AdmissionDocker, type AgentAdmissionWaitReason,
} from '../packages/core/src/agents/agentRunAdmission.js';
import {
    AgentAdmissionNestingError, agentRunGrantParentScope, createGoalParentNonce, goalParentScope, nestedLaunchGate, parentExecutionMarker,
    parentScopeFromIssueBody, runAsAgentAdmissionParent, runWithAgentAdmissionParent, currentAgentAdmissionNesting,
} from '../packages/core/src/agents/agentRunNesting.js';
import { agentAliasHasCapacity } from '../packages/core/src/agents/agentCapacity.js';
import { buildGoalPolicyEnvironment, buildNativeGoalContext } from '../packages/core/src/goals.js';

const required = process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1';
const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const run = randomUUID().slice(0, 8);
let root: string, redis: Redis | undefined, server: ChildProcess | undefined;
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

const endpoint = await startRedis();
const unavailable = endpoint ? undefined : `no ${binary} binary and no reachable REDIS_HOST/REDIS_PORT`;
const instances: string[] = [];
const instance = (name: string) => { const id = `nested-${run}-${name}`; instances.push(id); return id; };

before(async () => {
    if (!endpoint) {
        if (required) throw new Error(`Redis integration tests are required (PROPR_REQUIRE_REDIS_INTEGRATION=1) but ${unavailable}`);
        return;
    }
    root = await mkdtemp(path.join(tmpdir(), 'agent-nested-admission-'));
    const bin = path.join(root, 'bin'); await mkdir(bin);
    await writeFile(path.join(bin, 'docker'), `#!${process.execPath}\n${await readFile('test/fixtures/agent-admission/docker.mjs', 'utf8')}`);
    await chmod(path.join(bin, 'docker'), 0o755);
    Object.assign(process.env, { REDIS_HOST: endpoint.host, REDIS_PORT: String(endpoint.port), PATH: `${bin}:${process.env.PATH}`, PROPR_DEMO_MODE: 'true' });
});
after(async () => {
    for (const child of children) child.kill('SIGKILL');
    if (redis) {
        for (const name of instances) await redis.del(...agentAdmissionKeys(name));
        redis.disconnect();
    }
    server?.kill('SIGTERM');
    await (await import('../packages/core/src/db/connection.js')).closeConnection();
    if (root) await rm(root, { force: true, recursive: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
});
const integration = () => ({ skip: unavailable ? `Redis required: ${unavailable}` : false, timeout: 120_000 });
const client = () => redis!;

async function until(check: () => Promise<boolean> | boolean, timeout = 30_000, what = 'condition') {
    const end = Date.now() + timeout;
    while (!await check()) { if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`); await delay(20); }
}
function lifecycle() {
    let count = 0;
    const alive = new Set<string>();
    const runtime: AdmissionDocker = {
        daemon: async () => 'test', assertEmpty: async () => {},
        create: async () => { const id = `container-${++count}`; alive.add(id); return id; },
        remove: async id => { alive.delete(id); },
    };
    return { runtime, alive };
}
type Holder = { token: string; state: string; id?: string; alias?: string; parent?: string; shared?: boolean; deadline: number };
const holderRecords = async (name: string): Promise<Holder[]> => Object.entries(await client().hgetall(agentAdmissionKeys(name)[0])).map(([token, value]) => ({ token, ...JSON.parse(value) }));
function waiting(args: Parameters<typeof prepareAdmittedAgent>[1]) {
    const controller = new AbortController();
    let reported!: (reason: AgentAdmissionWaitReason) => void;
    const reason = new Promise<AgentAdmissionWaitReason>(resolve => { reported = resolve; });
    const admission = prepareAdmittedAgent(['run', 'agent'], { ...args, signal: controller.signal, pollMs: 10, onWaiting: value => reported(value) });
    void admission.catch(() => {});
    return { admission, reason, cancel: () => controller.abort(new Error('waiter cancelled')) };
}

// ---------------------------------------------------------------------------
// Multi-process helpers: one fixture worker per execution, the simulator's
// container records on disk.

async function writeRecord(directory: string, record: { id: string }) {
    const target = path.join(directory, `${record.id}.json`);
    await writeFile(target + '.tmp', JSON.stringify(record));
    await rename(target + '.tmp', target);
}
async function readRecords(directory: string): Promise<Array<{ id: string; state: string }>> {
    const values = await Promise.all((await readdir(directory)).filter(f => f.endsWith('.json')).map(async file => {
        try { return JSON.parse(await readFile(path.join(directory, file), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
    return values.filter(Boolean);
}
const running = async (directory: string) => (await readRecords(directory)).filter(r => r.state === 'running');
async function stop(directory: string, id: string) {
    const [record] = (await readRecords(directory)).filter(r => r.id === id);
    if (record) await writeRecord(directory, { ...record, stop: true } as never);
}

interface Launch { process: ChildProcess; done: Promise<void> }
function processes(name: string, directory: string, extra: Record<string, string>) {
    const env: NodeJS.ProcessEnv = { ...process.env, PROPR_INSTANCE_ID: name, PROPR_TEST_ADMISSION_DOCKER: directory, ...extra };
    delete env.PROPR_FLEET_CONTROL_SECRET;
    return (kind: 'standard' | 'native', options: { alias?: string; register?: string; parent?: string }): Launch => {
        const childEnv = { ...env, ...(options.alias ? { PROPR_TEST_AGENT_ALIAS: options.alias } : {}),
            ...(options.register ? { PROPR_TEST_REGISTER_SCOPE: options.register } : {}), ...(options.parent ? { PROPR_TEST_PARENT_SCOPE: options.parent } : {}) };
        const child = fork(path.resolve('test/fixtures/agent-admission/worker.ts'), [kind], { env: childEnv, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
        const done = new Promise<void>((resolve, reject) => {
            child.on('message', message => { if (typeof message === 'object') reject(new Error(JSON.stringify(message))); });
            child.on('exit', code => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}: ${stderr.slice(-2000)}`)));
        });
        void done.catch(() => {});
        children.push(child);
        return { process: child, done };
    };
}
async function newDirectory(label: string) { const directory = path.join(root, label); await mkdir(directory); return directory; }

// ---------------------------------------------------------------------------

test('parent links are explicit: goal nonce, issue marker, grant scope and async context', async () => {
    const nonce = createGoalParentNonce('goal-1');
    assert.equal(nonce, createGoalParentNonce('goal-1'), 'stable across attempts of one goal');
    assert.notEqual(nonce, createGoalParentNonce('goal-2'));
    assert.ok(!nonce.includes('goal-1'), 'the nonce does not reveal the goal ID');
    const body = `Implement the parser.\n\n${parentExecutionMarker(nonce)}\n`;
    assert.equal(parentScopeFromIssueBody(body), goalParentScope(nonce));
    for (const unlinked of [undefined, null, 42, 'no marker', '<!-- propr-parent-execution: short -->', '<!-- propr-parent-execution: agent-run-grant:abc -->']) {
        assert.equal(parentScopeFromIssueBody(unlinked), undefined, String(unlinked));
    }
    assert.equal(agentRunGrantParentScope('g1'), 'agent-run-grant:g1');
    assert.deepEqual(buildGoalPolicyEnvironment('orchestrate', nonce), { PROPR_EXECUTION_MODE: 'goal', PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate', PROPR_PARENT_EXECUTION: nonce });
    assert.deepEqual(buildGoalPolicyEnvironment('direct'), { PROPR_EXECUTION_MODE: 'goal', PROPR_GOAL_LAUNCH_STRATEGY: 'direct' }, 'direct goals carry no parent');
    assert.match(buildNativeGoalContext({ objective: 'x', launchStrategy: 'orchestrate' }), /<!-- propr-parent-execution: <value> -->/);
    assert.doesNotMatch(buildNativeGoalContext({ objective: 'x', launchStrategy: 'direct' }), /propr-parent-execution/);
    // A shared task label or timing never makes a launch nested: only the context does.
    assert.equal(currentAgentAdmissionNesting(), undefined);
    await runAsAgentAdmissionParent('goal:a', async () => {
        assert.deepEqual(currentAgentAdmissionNesting(), { register: 'goal:a' });
        await runWithAgentAdmissionParent('goal:a', async () => assert.deepEqual(currentAgentAdmissionNesting(), { parent: 'goal:a' }, 'a nested execution does not register'));
        await runWithAgentAdmissionParent(undefined, async () => assert.equal(currentAgentAdmissionNesting(), undefined, 'a task without a parent is top-level'));
    });
});

test('nested bound: configuration, and fan-out under a parent queues at the bound', async () => {
    const self = { PROPR_AGENT_RUN_LIMIT: '2', PROPR_INSTANCE_ID: 'self' };
    assert.deepEqual(resolveAgentRunAdmission(self), { instance: 'self', limit: 2 }, 'unset keeps the configuration shape');
    assert.equal(resolveAgentRunAdmission({ ...self, PROPR_AGENT_RUN_NESTED_LIMIT: '3' })?.nestedLimit, 3);
    for (const malformed of ['0', '-1', '1.5', 'many', '33']) {
        assert.throws(() => resolveAgentRunAdmission({ ...self, PROPR_AGENT_RUN_NESTED_LIMIT: malformed }), /PROPR_AGENT_RUN_NESTED_LIMIT/, malformed);
    }
    assert.throws(() => resolveAgentRunAdmission({ PROPR_AGENT_RUN_NESTED_LIMIT: '2' }), /requires agent-run admission/);
    let active = 0, peak = 0;
    const task = async () => { active++; peak = Math.max(peak, active); await delay(5); active--; };
    await runWithAgentAdmissionParent('agent-run-grant:g', () => {
        const gate = nestedLaunchGate({ PROPR_AGENT_RUN_NESTED_LIMIT: '3' });
        return Promise.all(Array.from({ length: 10 }, () => gate(task)));
    });
    assert.equal(peak, 3);
    peak = 0;
    const open = nestedLaunchGate({ PROPR_AGENT_RUN_NESTED_LIMIT: '3' });
    await Promise.all(Array.from({ length: 10 }, () => open(task)));
    assert.equal(peak, 10, 'no parent, no limit');
});

test('parent holding the only slot of an alias plus a nested execution on the same alias completes (multi-process)', integration(), async () => {
    const name = instance('same-alias');
    const directory = await newDirectory('same-alias');
    const launch = processes(name, directory, { PROPR_AGENT_RUN_LIMIT: '2', PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=1' });
    const scope = goalParentScope(createGoalParentNonce(randomUUID()));
    // An orchestrating goal session (native boundary) holds the alias's only slot.
    const parent = launch('native', { alias: 'local', register: scope });
    await until(async () => (await running(directory)).length === 1, 40_000, 'parent running');
    const config = resolveAgentRunAdmission({ PROPR_AGENT_RUN_LIMIT: '2', PROPR_INSTANCE_ID: name, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=1' })!;
    assert.equal(await agentAliasHasCapacity('local', { config, client: client() }), false, 'a top-level job on the alias is deferred');
    assert.equal(await runWithAgentAdmissionParent(scope, () => agentAliasHasCapacity('local', { config, client: client() })), true, 'its task is not deferred behind its own parent');
    // The task it started (standard boundary, another process) is charged under it.
    const nested = launch('standard', { alias: 'local', parent: scope });
    await until(async () => (await running(directory)).length === 2, 40_000, 'nested running');
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1 }, 'the nested execution takes no second slot of the alias');
    const [diagnostic] = await agentAdmissionNestedHolders(client(), name);
    assert.equal(diagnostic.parentAlias, 'local');
    assert.equal(diagnostic.nested.length, 1);
    assert.equal(diagnostic.nested[0].chargedUnderParent, true);
    assert.equal((await agentAdmissionMetrics(client(), name)).nested, 1);
    // Unrelated work on the alias still waits for the ceiling.
    const unrelated = launch('standard', { alias: 'local' });
    await until(async () => (await agentAdmissionMetrics(client(), name)).waiting === 1, 40_000, 'unrelated waiting');
    assert.equal((await readRecords(directory)).length, 2, 'the unrelated launch cannot create a container');
    const records = await holderRecords(name);
    const child = records.find(r => r.parent)!;
    const owner = records.find(r => !r.parent)!;
    await stop(directory, child.id!);
    await nested.done;
    await stop(directory, owner.id!);
    await parent.done;
    await until(async () => (await running(directory)).length === 1, 40_000, 'unrelated admitted');
    for (const record of await running(directory)) await stop(directory, record.id);
    await unrelated.done;
    await until(async () => await client().hlen(agentAdmissionKeys(name)[0]) === 0);
});

test('a global limit of one with one nested level cannot deadlock; the parent slot outlives its nested execution (multi-process)', integration(), async () => {
    const name = instance('global-one');
    const directory = await newDirectory('global-one');
    const launch = processes(name, directory, { PROPR_AGENT_RUN_LIMIT: '1' });
    const scope = goalParentScope(createGoalParentNonce(randomUUID()));
    const parent = launch('standard', { alias: 'goal-agent', register: scope });
    await until(async () => (await running(directory)).length === 1, 40_000, 'parent running');
    // A different agent, no per-agent policy: still charged under the parent's global slot.
    const nested = launch('native', { alias: 'task-agent', parent: scope });
    await until(async () => (await running(directory)).length === 2, 40_000, 'nested running at limit 1');
    const waiter = launch('standard', { alias: 'task-agent' });
    await until(async () => (await agentAdmissionMetrics(client(), name)).waiting === 1, 40_000, 'top-level waiter');
    const owner = (await holderRecords(name)).find(r => !r.parent)!;
    const child = (await holderRecords(name)).find(r => r.parent)!;
    assert.equal(child.shared, undefined, 'another alias is not charged to the parent alias');
    // The parent finishes first: its slot stays charged (draining) while the nested execution runs.
    await stop(directory, owner.id!);
    await until(async () => (await agentAdmissionMetrics(client(), name)).draining === 1, 40_000, 'parent draining');
    await delay(300);
    assert.equal((await readRecords(directory)).length, 1, 'no replacement starts while the nested execution runs');
    assert.equal((await agentAdmissionMetrics(client(), name)).waiting, 1);
    await stop(directory, child.id!);
    await nested.done;
    await parent.done;
    await until(async () => (await running(directory)).length === 1, 40_000, 'waiter admitted after the nested execution');
    for (const record of await running(directory)) await stop(directory, record.id);
    await waiter.done;
    await until(async () => await client().hlen(agentAdmissionKeys(name)[0]) === 0);
});

test('parent crash stops and removes its nested executions before the capacity is reused (multi-process)', integration(), async () => {
    const name = instance('crash');
    const directory = await newDirectory('crash');
    const launch = processes(name, directory, { PROPR_AGENT_RUN_LIMIT: '1', PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=1' });
    const scope = agentRunGrantParentScope(randomUUID());
    const parent = launch('standard', { alias: 'local', register: scope });
    await until(async () => (await running(directory)).length === 1, 40_000, 'parent running');
    const nested = launch('standard', { alias: 'local', parent: scope });
    await until(async () => (await running(directory)).length === 2, 40_000, 'nested running');
    const owner = (await holderRecords(name)).find(r => !r.parent)!;
    const child = (await holderRecords(name)).find(r => r.parent)!;
    // The parent's process dies; its container (and the nested one) survive.
    parent.process.kill('SIGKILL');
    await parent.done.catch(() => undefined);
    // Advance only the persisted deadline instead of sleeping out the lease.
    const { token, ...value } = (await holderRecords(name)).find(r => r.token === owner.token)!;
    await client().hset(agentAdmissionKeys(name)[0], token, JSON.stringify({ ...value, deadline: 0 }));
    const replacement = launch('standard', { alias: 'local' });
    let violation = '';
    await until(async () => {
        const records = await readRecords(directory);
        const fresh = records.filter(r => r.id !== owner.id && r.id !== child.id);
        if (fresh.length && records.some(r => r.id === owner.id || r.id === child.id)) violation ||= JSON.stringify(records.map(r => r.id));
        return fresh.some(r => r.state === 'running');
    }, 40_000, 'replacement running');
    assert.equal(violation, '', 'the replacement was created while the old containers still existed');
    assert.equal(existsSync(path.join(directory, `${owner.id}.json`)), false, 'parent container removed');
    assert.equal(existsSync(path.join(directory, `${child.id}.json`)), false, 'nested container removed');
    // Its container is gone, so the nested launcher ends (fenced or with its container's exit).
    await nested.done.catch(() => undefined);
    assert.equal((await holderRecords(name)).some(r => r.token === child.token), false, 'the nested execution does not outlive its fenced parent');
    for (const record of await running(directory)) await stop(directory, record.id);
    await replacement.done;
    await until(async () => await client().hlen(agentAdmissionKeys(name)[0]) === 0);
});

test('a nested execution on a different alias respects that alias\'s ceiling', integration(), async () => {
    const { runtime } = lifecycle();
    const name = instance('other-alias');
    const config: AdmissionConfig = { instance: name, limit: 2, aliasLimits: { local: 1, cloud: 1 } };
    const options = { client: client(), docker: runtime, config };
    const parent = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'local', nesting: { register: 'goal:other' } });
    const cloud = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'cloud' });
    const nested = waiting({ ...options, agentAlias: 'cloud', nesting: { parent: 'goal:other' } });
    assert.equal(await nested.reason, 'alias_limit', 'waits for the other alias, never for the global slot');
    await cloud!.finish();
    const admitted = await nested.admission;
    assert.deepEqual(await agentAdmissionAliasHolders(client(), name), { local: 1, cloud: 1 }, 'charged to its own alias');
    // It occupies that alias but no global slot: a top-level launch of a third agent still fits.
    const third = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'other' });
    const blocked = waiting({ ...options, agentAlias: 'cloud' });
    assert.equal(await blocked.reason, 'global_limit');
    blocked.cancel(); await assert.rejects(blocked.admission);
    for (const holder of [admitted, third, parent]) await holder!.finish();
    assert.equal(await client().hlen(agentAdmissionKeys(name)[0]), 0);
});

test('nesting depth and count bounds refuse with a clear error instead of waiting', integration(), async () => {
    const { runtime, alive } = lifecycle();
    const name = instance('bounds');
    const config: AdmissionConfig = { instance: name, limit: 1, nestedLimit: 2, aliasLimits: { local: 1 } };
    const options = { client: client(), docker: runtime, config, agentAlias: 'local' };
    const parent = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { register: 'goal:bounds' } });
    // A nested execution may register a scope of its own, but nothing nests under it.
    const first = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { parent: 'goal:bounds', register: 'agent-run-grant:inner' } });
    const second = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { parent: 'goal:bounds' } });
    assert.equal(alive.size, 3);
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { parent: 'goal:bounds' } }),
        (error: unknown) => error instanceof AgentAdmissionNestingError && error.reason === 'count' && /already carries 2 running nested executions \(PROPR_AGENT_RUN_NESTED_LIMIT=2\)/.test(error.message));
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { parent: 'agent-run-grant:inner' } }),
        (error: unknown) => error instanceof AgentAdmissionNestingError && error.reason === 'depth' && /limited to depth 1/.test(error.message));
    assert.equal(alive.size, 3, 'refusals create nothing');
    assert.equal((await agentAdmissionMetrics(client(), name)).waiting, 0, 'refusals leave no waiter');
    // A freed nested slot is usable again.
    await second!.finish();
    const again = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { parent: 'goal:bounds' } });
    // A finished (draining) parent accepts no new nested execution: it is then an ordinary launch.
    await parent!.finish();
    assert.equal((await agentAdmissionMetrics(client(), name)).draining, 1);
    const late = waiting({ ...options, nesting: { parent: 'goal:bounds' } });
    assert.equal(await late.reason, 'global_limit');
    for (const holder of [first, again]) await holder!.finish();
    const admitted = await late.admission;
    assert.equal((await holderRecords(name)).length, 1, 'the draining parent was released by its last nested execution');
    await admitted!.finish();
    assert.equal(await client().hlen(agentAdmissionKeys(name)[0]), 0);
    assert.equal(await client().hlen(agentAdmissionKeys(name)[3]), 0, 'no registered scope left behind');
});

test('fencing a parent (lease loss) fences its nested executions; a stale parent scope is an ordinary launch', integration(), async () => {
    const { runtime, alive } = lifecycle();
    const name = instance('fence');
    const config: AdmissionConfig = { instance: name, limit: 2 };
    const options = { client: client(), docker: runtime, config, agentAlias: 'local' };
    const parent = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { register: 'goal:fence' }, leaseMs: 600 });
    const nested = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { parent: 'goal:fence' }, leaseMs: 600 });
    // The parent's lease is lost (its process stalled): another admission recovers it.
    const [holders] = agentAdmissionKeys(name);
    const owner = (await holderRecords(name)).find(r => !r.parent)!;
    const { token, ...value } = owner;
    await client().hset(holders, token, JSON.stringify({ ...value, deadline: 0 }));
    const replacement = await prepareAdmittedAgent(['run', 'agent'], { ...options });
    await until(() => nested!.signal.aborted, 5_000, 'nested aborted');
    assert.equal(alive.has(owner.id!), false);
    assert.equal(alive.size, 1, 'only the replacement remains');
    await nested!.finish().catch(() => undefined);
    await parent!.finish().catch(() => undefined);
    // The parent is gone: its scope no longer charges anything under it.
    const ordinary = waiting({ ...options, nesting: { parent: 'goal:fence' } });
    const second = await ordinary.admission;
    assert.equal((await holderRecords(name)).every(r => !r.parent), true);
    await second!.finish(); await replacement!.finish();
    assert.equal(await client().hlen(holders), 0);
});

/** A lifecycle that records the order of container removals. */
function orderedLifecycle() {
    const { runtime, alive } = lifecycle();
    const removed: string[] = [];
    const remove = runtime.remove;
    runtime.remove = async id => { if (alive.has(id)) removed.push(id); await remove(id); };
    return { runtime, alive, removed };
}

test('local cleanup of a lease-lost parent removes and releases its nested execution first, without a replacement admission', integration(), async () => {
    const { runtime, alive, removed } = orderedLifecycle();
    const name = instance('local-fence');
    const config: AdmissionConfig = { instance: name, limit: 1 };
    const options = { client: client(), docker: runtime, config, agentAlias: 'local' };
    const parent = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { register: 'goal:local-fence' } });
    // The nested execution keeps renewing its own (long) lease in its process.
    const nested = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'cloud', nesting: { parent: 'goal:local-fence' }, leaseMs: 3_000 });
    const [holders] = agentAdmissionKeys(name);
    const owner = (await holderRecords(name)).find(r => !r.parent)!;
    const child = (await holderRecords(name)).find(r => r.parent)!;
    const { token, ...value } = owner;
    await client().hset(holders, token, JSON.stringify({ ...value, deadline: 0 }));
    // The parent's Docker caller unwinds into finish() before anything else recovers it.
    await parent!.finish();
    assert.deepEqual(removed, [child.id, owner.id], 'the nested container is removed before its parent');
    assert.equal(alive.size, 0);
    assert.equal(await client().hlen(holders), 0, 'both reservations are released, nested first');
    await until(() => nested!.signal.aborted, 10_000, 'nested renewal observes the fence');
    await nested!.finish();
    assert.equal(await client().hlen(holders), 0);
    // The global slot is reusable at once.
    const next = await prepareAdmittedAgent(['run', 'agent'], { ...options });
    await next!.finish();
});

test('a parent whose renewal finds its lease lost stops its nested execution before its own container', integration(), async () => {
    const { runtime, alive, removed } = orderedLifecycle();
    const name = instance('renew-fence');
    const config: AdmissionConfig = { instance: name, limit: 1 };
    const options = { client: client(), docker: runtime, config, agentAlias: 'local' };
    const parent = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { register: 'goal:renew-fence' }, leaseMs: 600 });
    const nested = await prepareAdmittedAgent(['run', 'agent'], { ...options, nesting: { parent: 'goal:renew-fence' } });
    const [holders] = agentAdmissionKeys(name);
    const owner = (await holderRecords(name)).find(r => !r.parent)!;
    const child = (await holderRecords(name)).find(r => r.parent)!;
    const { token, ...value } = owner;
    await client().hset(holders, token, JSON.stringify({ ...value, deadline: 0 }));
    await until(() => parent!.signal.aborted, 5_000, 'parent renewal observes the lost lease');
    await until(() => alive.size === 0, 5_000, 'containers removed');
    assert.deepEqual(removed, [child.id, owner.id], 'the nested container is removed before its parent');
    assert.equal((await holderRecords(name)).every(r => r.state === 'recovering'), true, 'capacity stays charged until release');
    await parent!.finish();
    assert.equal(await client().hlen(holders), 0);
    await nested!.finish();
    assert.equal(await client().hlen(holders), 0);
});
