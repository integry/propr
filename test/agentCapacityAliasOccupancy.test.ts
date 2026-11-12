/**
 * The advisory per-agent capacity pre-check (and the wake-up that shares its
 * rule) over a real Redis and the real admission script:
 * - a valid direct agent alias that names an Object.prototype member
 *   (`constructor`) is counted like any other alias, before and after its
 *   holder releases, and never inherits a ceiling it was not given;
 * - a job of a newer admission generation is not deferred by a live,
 *   renewing older-generation holder: it reaches the acquire, which fences
 *   and drains that holder before admitting it.
 *
 * Redis: a spawned `redis-server` when available (PROPR_TEST_REDIS_SERVER),
 * otherwise REDIS_HOST / REDIS_PORT (CI starts one with scripts/ci-redis.sh).
 * With PROPR_REQUIRE_REDIS_INTEGRATION=1, as CI sets, an unavailable Redis fails
 * the suite instead of skipping it.
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
    agentAdmissionAliasHolders, agentAdmissionKeys, prepareAdmittedAgent, resolveAdmissionAlias, resolveAgentRunAdmission,
    type AdmissionConfig, type AdmissionDocker,
} from '../packages/core/src/agents/agentRunAdmission.js';
import {
    AgentCapacityError, agentAdmissionAliasOccupancy, agentAliasHasCapacity, agentCapacityWaitersKey, configureAgentCapacityRedis,
    registerAgentCapacityWaiter, wakeAgentCapacityWaiters,
} from '../packages/core/src/agents/agentCapacity.js';
import { parseAgentRunAliasLimits } from '../packages/core/src/agents/agentRunAliasLimits.js';
import { checkJobAgentCapacity } from '../src/jobs/agentCapacityDeferral.js';

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
        const client = new Redis({ host, port, lazyConnect: true, retryStrategy: () => 25, maxRetriesPerRequest: null });
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
const instance = (name: string) => { const id = `occupancy-${run}-${name}`; instances.push(id); return id; };

before(() => {
    if (!endpoint && required) throw new Error(`Redis integration tests are required (PROPR_REQUIRE_REDIS_INTEGRATION=1) but ${unavailable}`);
    if (!endpoint) return;
    Object.assign(process.env, { REDIS_HOST: endpoint.host, REDIS_PORT: String(endpoint.port) });
    configureAgentCapacityRedis(redis);
});
after(async () => {
    configureAgentCapacityRedis(undefined);
    if (redis) {
        // Shared Redis: delete only this run's keys.
        for (const name of instances) await redis.del(...agentAdmissionKeys(name), agentCapacityWaitersKey(name, 'constructor'), agentCapacityWaitersKey(name, 'local'));
        redis.disconnect();
    }
    server?.kill('SIGTERM');
    // The configuration import graph opens the database pool; its reaper
    // interval would otherwise keep this file alive until the unit timeout.
    await (await import('../packages/core/src/db/connection.js')).closeConnection();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
});
const integration = () => ({ skip: unavailable ? `Redis required: ${unavailable}` : false, timeout: 30_000 });

function recording(prefix: string, events: string[]): AdmissionDocker {
    let count = 0;
    return {
        daemon: async () => 'test', assertEmpty: async () => {},
        create: async () => { const id = `${prefix}-${++count}`; events.push(`create ${id}`); return id; },
        remove: async id => { events.push(`remove ${id}`); },
    };
}

test('an alias named constructor is an ordinary alias: no inherited ceiling, and counted before and after its holder releases', integration(), async () => {
    const name = instance('constructor');
    const limits = parseAgentRunAliasLimits('constructor=1,local=1', 4);
    assert.equal(limits?.constructor, 1);
    const config: AdmissionConfig = { instance: name, limit: 4, aliasLimits: limits };
    const events: string[] = [];

    assert.equal(await agentAliasHasCapacity('constructor', { config }), true, 'empty holders: room');
    const held = await prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'constructor', client: redis!, docker: recording('c', events), config, pollMs: 10 });
    assert.ok(held);
    try {
        const occupancy = await agentAdmissionAliasOccupancy(redis!, name);
        assert.deepEqual(occupancy.aliases.get('constructor'), { live: 1, recoverable: 0 });
        assert.equal(occupancy.reconciliationPending, false);
        assert.deepEqual(await agentAdmissionAliasHolders(redis!, name), { constructor: 1 });
        assert.equal(await agentAliasHasCapacity('constructor', { config }), false, 'the live holder fills the ceiling (not NaN)');
        assert.equal(await agentAliasHasCapacity('local', { config }), true, 'other aliases are unaffected');
        assert.equal(await wakeAgentCapacityWaiters('constructor', { config }), 0);
    } finally {
        await held.finish();
    }
    // Nothing was written onto a shared prototype that a later lookup would read.
    assert.equal(({} as Record<string, unknown>).constructor, Object);
    assert.equal(await redis!.hlen(agentAdmissionKeys(name)[0]), 0);
    assert.deepEqual(await agentAdmissionAliasHolders(redis!, name), {});
    assert.equal((await agentAdmissionAliasOccupancy(redis!, name)).aliases.size, 0);
    assert.equal(await agentAliasHasCapacity('constructor', { config }), true, 'room again once the holder released');
    const again = await prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'constructor', client: redis!, docker: recording('d', events), config, pollMs: 10 });
    await again!.finish();

    // A direct agent named `constructor` without its own ceiling is not capped by Object.prototype.constructor.
    const uncapped: AdmissionConfig = { instance: name, limit: 4, aliasLimits: parseAgentRunAliasLimits('local=1', 4) };
    assert.equal(resolveAdmissionAlias(uncapped, { agentAlias: 'constructor' }).ceiling, '');
    const first = await prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'constructor', client: redis!, docker: recording('u', events), config: uncapped, pollMs: 10 });
    try {
        assert.equal(await agentAliasHasCapacity('constructor', { config: uncapped }), true);
        assert.equal(await wakeAgentCapacityWaiters('constructor', { config: uncapped }), 0, 'no ceiling, nothing to wake');
    } finally { await first!.finish(); }

    // Refusal messages name only ceilings that were given.
    assert.equal(new AgentCapacityError(['constructor']).message, "Waiting for agent capacity: 'constructor' at its ceiling");
    assert.equal(new AgentCapacityError(['constructor'], { constructor: 1 }).message, "Waiting for agent capacity: 'constructor' (limit 1) at its ceiling");
});

test('a newer admission generation is not deferred by a live older-generation holder; its acquire drains that holder', integration(), async () => {
    const name = instance('generation');
    const aliasLimits = parseAgentRunAliasLimits('local=1', 2);
    const old: AdmissionConfig = { instance: name, limit: 2, aliasLimits };
    const next: AdmissionConfig = { instance: name, limit: 2, generation: 1, aliasLimits };
    const events: string[] = [];
    // A long-running old-generation execution keeps renewing its lease.
    const stale = await prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'local', client: redis!, docker: recording('old', events), config: old, pollMs: 10, leaseMs: 600 });
    assert.ok(stale);
    try {
        await delay(700);
        const [record] = Object.values(await redis!.hgetall(agentAdmissionKeys(name)[0])).map(value => JSON.parse(value) as { state: string });
        assert.equal(record.state, 'running', 'the old holder is live: renewed past its first lease');
        assert.equal(await agentAliasHasCapacity('local', { config: old }), false, 'the old generation still sees its alias full');
        assert.equal((await agentAdmissionAliasOccupancy(redis!, name, 1)).reconciliationPending, true);
        assert.equal(await agentAliasHasCapacity('local', { config: next }), true, 'the new generation must reach the acquire to reconcile');

        // The queue-job path: the same process environment, now provisioned with generation 1.
        Object.assign(process.env, { PROPR_AGENT_RUN_LIMIT: '2', PROPR_INSTANCE_ID: name, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local=1', PROPR_AGENT_RUN_GENERATION: '1' });
        const registry = { beginRoutingSession: () => ({ select: async () => ({ physicalAgentAlias: 'local', physicalModel: 'model', synthetic: false }) }) };
        const job = { data: {}, updateData: async () => {} };
        const context = await checkJobAgentCapacity(job as never, [{ agentAlias: 'local' }], { registry: registry as never });
        assert.equal(context?.reservations[0]?.directAlias, 'local', 'not deferred');
        process.env.PROPR_AGENT_RUN_GENERATION = '0';
        await assert.rejects(checkJobAgentCapacity(job as never, [{ agentAlias: 'local' }], { registry: registry as never }), (error: unknown) => error instanceof AgentCapacityError,
            'an old-generation job is still deferred');

        // The new generation's acquire fences the old holder, removes its container, then admits.
        const admitted = await prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'local', client: redis!, docker: recording('new', events), config: next, pollMs: 10 });
        assert.ok(admitted);
        assert.ok(events.indexOf('remove old-1') >= 0 && events.indexOf('remove old-1') < events.indexOf('create new-1'), events.join(', '));
        assert.equal((await agentAdmissionAliasOccupancy(redis!, name, 1)).reconciliationPending, false, 'reconciled');
        assert.equal(await agentAliasHasCapacity('local', { config: next }), false, 'the new holder fills the ceiling');
        await admitted.finish();
        assert.equal(await agentAliasHasCapacity('local', { config: next }), true);
    } finally {
        for (const key of ['PROPR_AGENT_RUN_LIMIT', 'PROPR_INSTANCE_ID', 'PROPR_AGENT_RUN_ALIAS_LIMITS', 'PROPR_AGENT_RUN_GENERATION']) {
            if (key in previous) process.env[key] = previous[key]; else delete process.env[key];
        }
        // Fenced by the new generation: the old launcher's renewal fails and it stops; finishing frees nothing twice.
        await stale.finish().catch(() => undefined);
    }
    assert.equal(await redis!.hlen(agentAdmissionKeys(name)[0]), 0, 'no holder left behind');
});

test('a release seen by a newer-generation process wakes a waiter despite live older holders', integration(), async () => {
    const name = instance('generation-wake');
    const aliasLimits = parseAgentRunAliasLimits('local=1', 2);
    const old: AdmissionConfig = { instance: name, limit: 2, aliasLimits };
    const next: AdmissionConfig = { instance: name, limit: 2, generation: 1, aliasLimits };
    const queue = new Queue(`occupancy-${run}`, { connection: redis! });
    const stale = await prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'local', client: redis!, docker: recording('old', []), config: old, pollMs: 10 });
    try {
        const job = await queue.add('local', { agentCapacityAliases: ['local'] }, { delay: 60_000, jobId: 'W1' });
        await registerAgentCapacityWaiter(['local'], JSON.stringify([queue.name, job.id]), Date.now(), { config: old });
        assert.equal(await wakeAgentCapacityWaiters('local', { config: old }), 0, 'the old generation sees no free slot');
        assert.equal(await job.isDelayed(), true);
        assert.equal(await wakeAgentCapacityWaiters('local', { config: next }), 1, 'the new generation wakes it: its acquire drains the old holder');
        assert.equal(await (await queue.getJob('W1'))!.isDelayed(), false);
    } finally {
        await stale!.finish().catch(() => undefined);
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
    }
});
