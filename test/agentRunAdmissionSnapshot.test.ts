/**
 * The agent-run admission report (`readAgentRunAdmissionSnapshot`) over a real
 * Redis, with real contention through `prepareAdmittedAgent`: counts, the
 * split of waiting reasons, nested executions apart from holders, deferred
 * queue jobs, repository workflow slots, redaction and the disabled case.
 * Redis: a spawned `redis-server` when available (PROPR_TEST_REDIS_SERVER),
 * otherwise REDIS_HOST / REDIS_PORT. With PROPR_REQUIRE_REDIS_INTEGRATION=1 an
 * unavailable Redis fails the suite instead of skipping it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
    agentAdmissionDetailsKey, agentAdmissionKeys, prepareAdmittedAgent, type AdmissionConfig, type AdmissionDocker, type AgentAdmissionWaitReason,
} from '../packages/core/src/agents/agentRunAdmission.js';
import { agentCapacityWaitersKey, configureAgentCapacityRedis, registerAgentCapacityWaiter } from '../packages/core/src/agents/agentCapacity.js';
import { readAgentRunAdmissionSnapshot } from '../packages/core/src/agents/agentRunAdmissionSnapshot.js';
import { ACQUIRE_WORKFLOW_SLOT, repositoryWorkflowSlotKeys } from '../packages/core/src/workflow/workflowConcurrency.js';

const required = process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1';
const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const run = randomUUID().slice(0, 8);
let redis: Redis | undefined, server: ChildProcess | undefined;
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
const queues: string[] = [];
const instance = (name: string) => { const id = `snapshot-${run}-${name}`; instances.push(id); return id; };
const client = () => redis!;
const integration = () => ({ skip: unavailable ? `Redis required: ${unavailable}` : false, timeout: 60_000 });

before(() => {
    if (!endpoint) {
        if (required) throw new Error(`Redis integration tests are required (PROPR_REQUIRE_REDIS_INTEGRATION=1) but ${unavailable}`);
        return;
    }
    Object.assign(process.env, { REDIS_HOST: endpoint.host, REDIS_PORT: String(endpoint.port) });
    configureAgentCapacityRedis(redis);
});
after(async () => {
    configureAgentCapacityRedis(undefined);
    if (redis) {
        for (const name of instances) {
            await redis.del(...agentAdmissionKeys(name), agentAdmissionDetailsKey(name), ...['local', 'cloud'].map(alias => agentCapacityWaitersKey(name, alias)));
        }
        for (const name of queues) await new Queue(name, { connection: redis }).obliterate({ force: true }).catch(() => undefined);
        redis.disconnect();
    }
    server?.kill('SIGTERM');
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
});

const DAEMON = `daemon-${run}-secret`;
function lifecycle(): AdmissionDocker {
    let count = 0;
    return {
        daemon: async () => DAEMON,
        assertEmpty: async () => {},
        // 64-hex, like real immutable IDs, so redaction can look for them.
        create: async () => `${String(++count).padStart(8, '0')}${'c'.repeat(56)}`,
        remove: async () => {},
    };
}
/** An admission expected to wait; resolves each reported wait reason. */
function waiter(options: Parameters<typeof prepareAdmittedAgent>[1]) {
    const controller = new AbortController();
    const reasons: AgentAdmissionWaitReason[] = [];
    const admission = prepareAdmittedAgent(['run', 'agent'], { ...options, signal: controller.signal, pollMs: 10, onWaiting: reason => { reasons.push(reason); } });
    void admission.catch(() => {});
    return { admission, reasons, cancel: () => controller.abort(new Error('waiter cancelled')) };
}
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 10_000) {
    const end = Date.now() + timeout;
    while (!await check()) { if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`); await delay(15); }
}
const snapshot = (config: AdmissionConfig | null, env: NodeJS.ProcessEnv = { PROPR_AGENT_RUN_LIMIT: '3' }) =>
    readAgentRunAdmissionSnapshot({ client: client(), config, env });
const agentOf = (report: Awaited<ReturnType<typeof snapshot>>, alias: string) => report.agents.find(agent => agent.alias === alias)!;

test('counts under contention: holders, waits split by global limit and agent ceiling, and recorded tasks', integration(), async () => {
    const name = instance('contention');
    const config: AdmissionConfig = { instance: name, limit: 3, aliasLimits: { local: 1 } };
    const options = { client: client(), docker: lifecycle(), config };
    const local = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'local', taskId: 'task-local-1' });
    const cloud = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'cloud', taskId: 'task-cloud-1' });
    const second = waiter({ ...options, agentAlias: 'local', taskId: 'task-local-2' });
    await until(() => second.reasons.includes('alias_limit'), 'the alias-ceiling wait');

    let report = await snapshot(config);
    assert.equal(report.enabled, true);
    assert.equal(report.agentCeilingsConfigured, true);
    assert.deepEqual({ ...report.global, holders: undefined, waiting: undefined }, {
        limit: 3, limitSource: 'PROPR_AGENT_RUN_LIMIT', generation: 0, nestedLimit: 4, nestedLimitSource: 'default', inUse: 2,
        holders: undefined, unattributedHolders: 0, nested: { total: 0, chargedUnderParent: 0, countedAgainstOtherAgent: 0 }, waiting: undefined, deferred: 0,
    });
    assert.deepEqual(report.global!.holders, { reserved: 0, running: 2, draining: 0, recovering: 0, total: 2 });
    assert.deepEqual(report.global!.waiting, { total: 1, globalLimit: 0, agentCeiling: 1, recovering: 0, starting: 0 });
    assert.equal(agentOf(report, 'local').ceiling, 1);
    assert.equal(agentOf(report, 'local').inUse, 1);
    assert.equal(agentOf(report, 'local').waiting.agentCeiling, 1);
    assert.equal(agentOf(report, 'cloud').ceiling, null, 'an agent without an entry is limited by the global limit only');
    assert.deepEqual(agentOf(report, 'local').tasks.map(task => [task.taskId, task.state, task.waitReason]).sort(), [
        ['task-local-1', 'running', undefined], ['task-local-2', 'waiting', 'alias_limit'],
    ]);

    // Fill the global limit with concurrent launches of another agent: the overflow waits on the global limit.
    const clouds = [await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'cloud' })];
    const overflow = Array.from({ length: 3 }, () => waiter({ ...options, agentAlias: 'cloud' }));
    await until(() => overflow.every(item => item.reasons.includes('global_limit')) && second.reasons.at(-1) === 'global_limit', 'global-limit waits');
    report = await snapshot(config);
    assert.equal(report.global!.inUse, 3);
    assert.deepEqual(report.global!.waiting, { total: 4, globalLimit: 4, agentCeiling: 0, recovering: 0, starting: 0 });
    assert.deepEqual(agentOf(report, 'cloud').waiting, { total: 3, globalLimit: 3, agentCeiling: 0, recovering: 0, starting: 0 });

    // A released holder leaves the report and its detail is gone.
    await local!.finish();
    await until(async () => (await snapshot(config)).agents.find(agent => agent.alias === 'local')!.tasks.every(task => task.taskId !== 'task-local-1'), 'release');
    for (const item of [second, ...overflow]) item.cancel();
    await Promise.allSettled([second.admission, ...overflow.map(item => item.admission)]);
    for (const admitted of [cloud, ...clouds, ...(await Promise.allSettled([second.admission, ...overflow.map(item => item.admission)]))
        .map(result => result.status === 'fulfilled' ? result.value : null)]) await admitted?.finish();
    await until(async () => (await client().hlen(agentAdmissionDetailsKey(name))) === 0, 'no details left behind');
    report = await snapshot(config);
    assert.equal(report.global!.inUse, 0);
    assert.equal(report.global!.waiting.total, 0);
});

test('nested executions are shown apart from holders, and an expired lease counts as recovering', integration(), async () => {
    const name = instance('nested');
    const config: AdmissionConfig = { instance: name, limit: 1, aliasLimits: { local: 1 } };
    const options = { client: client(), docker: lifecycle(), config };
    const parent = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'local', taskId: 'goal-task', nesting: { register: `goal:${run}` } });
    const sameAgent = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'local', taskId: 'child-same', nesting: { parent: `goal:${run}` } });
    const otherAgent = await prepareAdmittedAgent(['run', 'agent'], { ...options, agentAlias: 'cloud', taskId: 'child-other', nesting: { parent: `goal:${run}` } });
    const report = await snapshot(config);
    assert.equal(report.global!.inUse, 1, 'nested executions take no global slot');
    assert.equal(report.global!.holders.total, 1);
    assert.deepEqual(report.global!.nested, { total: 2, chargedUnderParent: 1, countedAgainstOtherAgent: 1 });
    assert.deepEqual(agentOf(report, 'local').nested, { total: 1, chargedUnderParent: 1, countedAgainstCeiling: 0 });
    assert.equal(agentOf(report, 'local').inUse, 1, 'charged under the parent, not counted twice');
    assert.deepEqual(agentOf(report, 'cloud').holders.total, 0);
    assert.deepEqual(agentOf(report, 'cloud').nested, { total: 1, chargedUnderParent: 0, countedAgainstCeiling: 1 });
    assert.ok(agentOf(report, 'local').tasks.some(task => task.taskId === 'child-same' && task.nested));
    for (const admitted of [otherAgent, sameAgent, parent]) await admitted!.finish();

    // A holder whose process died: its lease passed, recovery has not run yet.
    const [holders] = agentAdmissionKeys(name);
    await client().hset(holders, 'dead-token', JSON.stringify({ state: 'running', deadline: 1, alias: 'local', id: 'f'.repeat(64) }));
    const stale = await snapshot(config);
    assert.equal(stale.global!.holders.recovering, 1);
    assert.equal(agentOf(stale, 'local').holders.recovering, 1);
    await client().hdel(holders, 'dead-token');
});

test('deferred jobs count only waiters whose queue job is still delayed', integration(), async () => {
    const name = instance('deferred');
    const config: AdmissionConfig = { instance: name, limit: 2, aliasLimits: { local: 1 } };
    const queueName = `snapshot-deferred-${run}`;
    queues.push(queueName);
    const queue = new Queue(queueName, { connection: client() });
    try {
        await queue.add('job', { agentCapacityDeferrals: 1 }, { jobId: 'delayed-1', delay: 60_000 });
        await queue.add('job', { agentCapacityDeferrals: 1 }, { jobId: 'delayed-2', delay: 60_000 });
        await queue.add('job', {}, { jobId: 'waiting-1' });
        const key = agentCapacityWaitersKey(name, 'local');
        for (const [score, id] of [[1, 'delayed-1'], [2, 'delayed-2'], [3, 'waiting-1'], [4, 'gone']] as const) {
            await client().zadd(key, score, JSON.stringify([queueName, id]));
        }
        await client().zadd(key, 5, 'not json');
        const report = await snapshot(config);
        assert.equal(agentOf(report, 'local').deferred, 2, 'a re-entering, missing or malformed waiter is not deferred');
        assert.equal(report.global!.deferred, 2);
    } finally { await queue.close(); }
});

test('removing a ceiling keeps its still-delayed jobs in the report until their backoff passes', integration(), async () => {
    const name = instance('removed-ceiling');
    const capped: AdmissionConfig = { instance: name, limit: 2, aliasLimits: { local: 1, cloud: 1 } };
    const queueName = `snapshot-removed-${run}`;
    queues.push(queueName);
    const queue = new Queue(queueName, { connection: client() });
    try {
        // Deferred while the ceilings were configured, through the real registration path.
        await queue.add('job', { agentCapacityDeferrals: 1, agentCapacityAliases: ['local'] }, { jobId: 'local-deferred', delay: 60_000 });
        // Its latest refusal names only `cloud`: it no longer waits for `local`, whose list still holds it.
        await queue.add('job', { agentCapacityDeferrals: 2, agentCapacityAliases: ['cloud'] }, { jobId: 'moved-on', delay: 60_000 });
        await registerAgentCapacityWaiter(['local'], JSON.stringify([queueName, 'local-deferred']), 1, { client: client(), config: capped });
        await registerAgentCapacityWaiter(['local', 'cloud'], JSON.stringify([queueName, 'moved-on']), 2, { client: client(), config: capped });

        // The `local` ceiling removed (restart with global admission kept): its job is still pending.
        let report = await snapshot({ instance: name, limit: 2, aliasLimits: { cloud: 1 } });
        assert.equal(agentOf(report, 'local').ceiling, null, 'a removed ceiling is reported as none');
        assert.equal(agentOf(report, 'local').deferred, 1, 'a job waiting only for another agent is not deferred for this one');
        assert.equal(agentOf(report, 'cloud').deferred, 1);
        assert.equal(report.global!.deferred, 2);

        // The last ceiling removed: no ceiling is configured, yet both jobs are still deferred.
        report = await snapshot({ instance: name, limit: 2 });
        assert.equal(report.agentCeilingsConfigured, false);
        assert.deepEqual(report.agents.map(agent => [agent.alias, agent.ceiling, agent.deferred]), [['cloud', null, 1], ['local', null, 1]]);
        assert.equal(report.global!.deferred, 2);

        // Once the jobs leave the delayed state, the removed aliases leave the report.
        await (await queue.getJob('local-deferred'))!.promote();
        await (await queue.getJob('moved-on'))!.promote();
        report = await snapshot({ instance: name, limit: 2 });
        assert.deepEqual(report.agents, []);
        assert.equal(report.global!.deferred, 0);
    } finally { await queue.close(); }
});

test('redaction: no tokens, container IDs, daemon identity or instance ID', integration(), async () => {
    const name = instance('redaction');
    const config: AdmissionConfig = { instance: name, limit: 2, aliasLimits: { local: 1 } };
    const admitted = await prepareAdmittedAgent(['run', 'agent'], { client: client(), docker: lifecycle(), config, agentAlias: 'local', taskId: 'task-redaction' });
    try {
        const [holders] = agentAdmissionKeys(name);
        const tokens = Object.keys(await client().hgetall(holders));
        const text = JSON.stringify(await snapshot(config));
        for (const secret of [...tokens, admitted!.id, DAEMON, name, holders]) assert.ok(!text.includes(secret), `report must not contain ${secret.slice(0, 12)}…`);
        assert.ok(text.includes('task-redaction'), 'task IDs are returned for the caller to filter');
    } finally { await admitted!.finish(); }
});

test('admission off: the report says so and still returns repository workflow slots', integration(), async () => {
    const repository = `acme/snapshot-${run}`;
    const keys = repositoryWorkflowSlotKeys(repository);
    await client().eval(ACQUIRE_WORKFLOW_SLOT, 4, ...keys, 'slot-a', '2', '');
    await client().eval(ACQUIRE_WORKFLOW_SLOT, 4, ...keys, 'slot-b', '2', '');
    await client().eval(ACQUIRE_WORKFLOW_SLOT, 4, ...keys, 'slot-c', '2', JSON.stringify(['queue', 'deferred']));
    const uncapped = repositoryWorkflowSlotKeys(`acme/uncapped-${run}`);
    await client().eval(ACQUIRE_WORKFLOW_SLOT, 4, ...uncapped, 'slot-x', '0', '');
    try {
        const report = await readAgentRunAdmissionSnapshot({ client: client(), env: {} });
        assert.equal(report.enabled, false);
        assert.equal(report.global, undefined);
        assert.deepEqual(report.agents, []);
        assert.equal(report.unavailable, undefined);
        assert.equal(report.repositoryWorkflowSlotsUnavailable, undefined, 'a successful read is not marked unavailable');
        const slots = report.repositoryWorkflowSlots.filter(slot => slot.repository.includes(run));
        assert.deepEqual(slots, [{ repository: repository.toLowerCase(), inUse: 2, limit: 2, waiting: 1 }], 'a repository without a limit is not listed');
        // A malformed policy is reported, never thrown, and repository usage is still read.
        const invalid = await readAgentRunAdmissionSnapshot({ client: client(), env: { PROPR_AGENT_RUN_LIMIT: 'many' } });
        assert.equal(invalid.enabled, true);
        assert.match(invalid.unavailable!, /Invalid admission configuration/);
        assert.doesNotMatch(invalid.unavailable!, /many/);
        assert.equal(invalid.repositoryWorkflowSlotsUnavailable, undefined);
        assert.deepEqual(invalid.repositoryWorkflowSlots.filter(slot => slot.repository.includes(run)), slots);
    } finally {
        await client().del(...keys, ...uncapped);
    }
});

test('admission off: every repository with a limit is listed, past any discovery bound', integration(), async () => {
    // Uncapped repositories sort first, so a bound applied before the limit check would drop capped ones.
    const capped = Array.from({ length: 520 }, (_, index) => `acme/many-${run}-z${String(index).padStart(4, '0')}`);
    const uncapped = Array.from({ length: 120 }, (_, index) => `acme/many-${run}-a${String(index).padStart(4, '0')}`);
    const pipeline = client().pipeline();
    for (const repository of capped) pipeline.eval(ACQUIRE_WORKFLOW_SLOT, 4, ...repositoryWorkflowSlotKeys(repository), 'slot', '1', '');
    for (const repository of uncapped) pipeline.eval(ACQUIRE_WORKFLOW_SLOT, 4, ...repositoryWorkflowSlotKeys(repository), 'slot', '0', '');
    await pipeline.exec();
    try {
        const report = await readAgentRunAdmissionSnapshot({ client: client(), env: {} });
        assert.equal(report.repositoryWorkflowSlotsUnavailable, undefined);
        const listed = report.repositoryWorkflowSlots.filter(slot => slot.repository.startsWith(`acme/many-${run}-`));
        assert.deepEqual(listed.map(slot => slot.repository), capped, 'all 520 capped repositories, none of the uncapped');
        assert.ok(listed.every(slot => slot.inUse === 1 && slot.limit === 1));
    } finally {
        await client().del(...[...capped, ...uncapped].flatMap(repository => repositoryWorkflowSlotKeys(repository)));
    }
});

test('Redis unreachable: repository usage is reported unavailable, not empty, whether admission is off or on', async () => {
    for (const env of [{}, { PROPR_AGENT_RUN_LIMIT: '2', PROPR_INSTANCE_ID: 'unreachable' }, { PROPR_AGENT_RUN_LIMIT: 'many' }]) {
        const unreachable = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0, enableOfflineQueue: false });
        unreachable.on('error', () => {});
        const report = await readAgentRunAdmissionSnapshot({ env, client: unreachable });
        unreachable.disconnect();
        assert.equal(report.enabled, Object.keys(env).length > 0);
        assert.deepEqual(report.repositoryWorkflowSlots, []);
        assert.match(report.repositoryWorkflowSlotsUnavailable!, /could not be read/);
        if (report.enabled) assert.ok(report.unavailable);
        else assert.equal(report.unavailable, undefined);
    }
});
