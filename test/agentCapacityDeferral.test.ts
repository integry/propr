/**
 * Jobs whose direct agent is at its per-agent ceiling are deferred (real BullMQ
 * queue and worker over a real Redis) instead of holding a worker: no attempt
 * is consumed, another agent keeps progressing on the freed worker, a released
 * holder (here acquired like an API-process launch, through the real admission
 * script) wakes the oldest waiter first, the timeline keeps one waiting row,
 * and a lost race at the authoritative acquire turns into a deferral only for
 * deferrable jobs.
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
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { agentAdmissionKeys, prepareAdmittedAgent, resolveAgentRunAdmission, type AdmissionDocker } from '../packages/core/src/agents/agentRunAdmission.js';
import {
    AgentCapacityError, AgentCapacityWaitTimeoutError, agentAliasHasCapacity, agentCapacityWaitersKey, configureAgentCapacityRedis, runWithAgentCapacityContext,
    wakeAgentCapacityWaiters,
} from '../packages/core/src/agents/agentCapacity.js';
import { deferCapacityJob } from '../src/jobs/repositoryWorkflow.js';
import { admitAgentCapacity, checkJobAgentCapacity, isAgentCapacityRefusal, persistAgentCapacityDeferral } from '../src/jobs/agentCapacityDeferral.js';
import { markAgentExecutionFailure, isAgentExecutionFailure } from '../src/jobs/providerReplacement.js';
import { isTransientProviderError } from '../src/taskReplacement/policy.js';

const required = process.env.PROPR_REQUIRE_REDIS_INTEGRATION === '1';
const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const run = randomUUID().slice(0, 8);
let redis: Redis | undefined, server: ChildProcess | undefined;
const previous = { ...process.env };
const log = { info() {}, warn() {}, error() {}, debug() {} } as never;

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
const instanceId = `capacity-${run}`;
const queues: string[] = [];

before(() => {
    if (!endpoint && required) throw new Error(`Redis integration tests are required (PROPR_REQUIRE_REDIS_INTEGRATION=1) but ${unavailable}`);
    if (!endpoint) return;
    Object.assign(process.env, {
        REDIS_HOST: endpoint.host, REDIS_PORT: String(endpoint.port),
        PROPR_AGENT_RUN_LIMIT: '4', PROPR_INSTANCE_ID: instanceId, PROPR_AGENT_RUN_ALIAS_LIMITS: 'local-llama=1,remote-llama=1',
    });
    configureAgentCapacityRedis(redis);
});
after(async () => {
    configureAgentCapacityRedis(undefined);
    if (redis) {
        // Shared Redis: delete only this run's keys.
        await redis.del(...agentAdmissionKeys(instanceId), agentCapacityWaitersKey(instanceId, 'local-llama'), agentCapacityWaitersKey(instanceId, 'remote-llama'));
        for (const name of queues) { const queue = new Queue(name, { connection: redis }); await queue.obliterate({ force: true }).catch(() => {}); await queue.close(); }
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

function docker(): AdmissionDocker {
    let count = 0;
    return { daemon: async () => 'test', assertEmpty: async () => {}, create: async () => `container-${++count}`, remove: async () => {} };
}
/** A launch holding a slot for `alias`, acquired through the real admission script (as the API process does). */
function holder(alias: string) {
    return prepareAdmittedAgent(['run', 'agent'], { agentAlias: alias, client: redis!, docker: docker(), config: resolveAgentRunAdmission()!, pollMs: 10 });
}
/** Direct agents only: the request's alias is the charged alias. */
const registry = { beginRoutingSession: (options: { requestedAgentAlias: string }) => ({
    select: async () => ({ physicalAgentAlias: options.requestedAgentAlias, physicalModel: 'model', synthetic: false }),
}) };

/** An in-memory task timeline with the state manager calls the deferral uses. */
function timeline() {
    const tasks = new Map<string, { state: string; createdAt: string; updatedAt: string; correlationId: string; version: number; history: Array<{ state: string; reason?: string; metadata?: Record<string, unknown> }> }>();
    const stateManager = {
        getTaskState: async (id: string) => {
            if (!tasks.has(id)) tasks.set(id, { state: 'pending', createdAt: 'c', updatedAt: 'u', correlationId: id, version: 1, history: [{ state: 'pending' }] });
            return tasks.get(id)!;
        },
        updateTaskStateIfCurrent: async (id: string, _expected: unknown, state: string, update: { reason: string; historyMetadata: Record<string, unknown> }) => {
            tasks.get(id)!.history.push({ state, reason: update.reason, metadata: update.historyMetadata });
            return tasks.get(id);
        },
        updateHistoryMetadata: async (id: string, _state: string, metadata: Record<string, unknown>) => {
            const latest = tasks.get(id)!.history.at(-1)!;
            latest.metadata = { ...latest.metadata, ...metadata };
            return tasks.get(id);
        },
    };
    return { tasks, stateManager };
}

async function until(check: () => Promise<boolean> | boolean, timeout = 8_000, label = 'condition') {
    const end = Date.now() + timeout;
    while (!await check()) { if (Date.now() > end) assert.fail(`Timed out waiting for ${label}`); await delay(20); }
}

test('a saturated agent defers its jobs without consuming attempts, other agents progress, and a release wakes the oldest waiter', integration(), async () => {
    const name = `agent-capacity-${run}`;
    queues.push(name);
    const queue = new Queue(name, { connection: redis! });
    const { tasks, stateManager } = timeline();
    const ran: string[] = [];
    const held = await holder('local-llama');
    const workerConnection = redis!.duplicate();
    let worker: Worker | undefined;
    try {
        worker = new Worker(name, (job: Job<{ alias: string }>) => deferCapacityJob(job, async () => {
            try {
                await checkJobAgentCapacity(job, [{ agentAlias: job.data.alias }], { registry });
                await admitAgentCapacity(job);
            } catch (error) {
                if (isAgentCapacityRefusal(error)) await persistAgentCapacityDeferral({ job, error, stateManager: stateManager as never, taskId: job.id!, correlatedLogger: log });
                throw error;
            }
            ran.push(job.id!);
            return 'done';
        }), { connection: workerConnection, concurrency: 1 });
        const options = { attempts: 3, removeOnComplete: false };
        await queue.add('local', { alias: 'local-llama' }, { ...options, jobId: 'L1' });
        await delay(5); // Distinct waiting-list scores.
        await queue.add('local', { alias: 'local-llama' }, { ...options, jobId: 'L2' });
        await queue.add('cloud', { alias: 'cloud' }, { ...options, jobId: 'C1' });

        // One worker: it was released by both deferrals, so the other agent's job ran.
        await until(() => ran.includes('C1'), 8_000, 'the cloud job');
        await until(async () => (await queue.getDelayedCount()) === 2, 8_000, 'two deferrals');
        assert.deepEqual(ran, ['C1']);
        for (const id of ['L1', 'L2']) {
            const job = (await queue.getJob(id))!;
            assert.equal(job.attemptsMade, 0, 'a capacity wait consumes no attempt');
            assert.equal(job.data.agentCapacityDeferrals, 1);
            assert.deepEqual(job.data.agentCapacityAliases, ['local-llama']);
            assert.ok(job.data.agentCapacityRetryAt > Date.now() + 2_000, 'backed off, not polling');
            const rows = tasks.get(id)!.history.filter(row => row.metadata?.agentCapacityDeferrals);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].reason, 'Waiting for agent capacity: local-llama (limit 1)');
            assert.equal(rows[0].metadata!.agentCapacityRetryAt, new Date(job.data.agentCapacityRetryAt).toISOString(), 'timeline and delayed job agree');
        }
        const waiters = await redis!.zrange(agentCapacityWaitersKey(instanceId, 'local-llama'), 0, -1);
        assert.deepEqual(waiters.map(waiter => JSON.parse(waiter)[1]), ['L1', 'L2'], 'oldest first');

        // A repeated deferral updates the same waiting row in place.
        const l2 = (await queue.getJob('L2'))!;
        await l2.promote();
        await until(async () => (await queue.getJob('L2'))!.data.agentCapacityDeferrals === 2, 8_000, 'second deferral');
        assert.equal((await queue.getJob('L2'))!.attemptsMade, 0);
        const l2Rows = tasks.get('L2')!.history.filter(row => row.metadata?.agentCapacityDeferrals);
        assert.equal(l2Rows.length, 1, 'one waiting row per wait');
        assert.equal(l2Rows[0].metadata!.agentCapacityDeferrals, 2);
        assert.equal((await redis!.zrange(agentCapacityWaitersKey(instanceId, 'local-llama'), 0, 0))[0], JSON.stringify([name, 'L1']), 'a re-deferral keeps its place');

        // The holder finishes: one slot frees, the oldest waiter is woken well before its backoff.
        const released = Date.now();
        await held.finish();
        await until(() => ran.includes('L1'), 4_000, 'the oldest waiter');
        assert.ok(Date.now() - released < 4_000);
        assert.ok(!ran.includes('L2'), 'one free slot wakes one waiter');
        const l1 = (await queue.getJob('L1'))!;
        assert.equal(l1.attemptsMade, 1, 'the only attempt is the one that ran');
        assert.equal(l1.data.agentCapacityDeferrals, undefined, 'admission clears the wait');
        assert.deepEqual((await redis!.zrange(agentCapacityWaitersKey(instanceId, 'local-llama'), 0, -1)).map(waiter => JSON.parse(waiter)[1]), ['L2']);
    } finally {
        await worker?.close(true);
        workerConnection.disconnect();
        await queue.close();
        await held.finish().catch(() => {});
    }
});

test('a waiter whose job ended is dropped from the waiting list without using up the wakeup', integration(), async () => {
    const name = `agent-capacity-ended-${run}`;
    queues.push(name);
    const queue = new Queue(name, { connection: redis! });
    const key = agentCapacityWaitersKey(instanceId, 'local-llama');
    try {
        const held = await holder('local-llama');
        const gone = await queue.add('x', {}, { jobId: 'gone', delay: 60_000 });
        await gone.remove();
        const waiting = await queue.add('x', {}, { jobId: 'waiting', delay: 60_000 });
        await redis!.del(key);
        await redis!.zadd(key, 1, JSON.stringify([name, 'gone']), 2, JSON.stringify([name, 'waiting']));
        await held.finish();
        await until(async () => !(await waiting.isDelayed()), 4_000, 'the live waiter');
        assert.equal(await redis!.zscore(key, JSON.stringify([name, 'gone'])), null);
    } finally {
        await redis!.del(key);
        await queue.close();
    }
});

test('a refusal that stops naming an alias leaves its waiting list, and a wakeup skips such a waiter without using the slot', integration(), async () => {
    const name = `agent-capacity-moved-${run}`;
    queues.push(name);
    const queue = new Queue(name, { connection: redis! });
    const local = agentCapacityWaitersKey(instanceId, 'local-llama'), remote = agentCapacityWaitersKey(instanceId, 'remote-llama');
    const members = async (key: string) => (await redis!.zrange(key, 0, -1)).map(waiter => JSON.parse(waiter)[1]);
    const heldLocal = await holder('local-llama'), heldRemote = await holder('remote-llama');
    try {
        await redis!.del(local, remote);
        // A review blocked by both reviewers joins both lists.
        const review = await queue.add('x', {}, { jobId: 'review', delay: 60_000 });
        await persistAgentCapacityDeferral({ job: review as never, error: new AgentCapacityError(['local-llama', 'remote-llama']), correlatedLogger: log });
        assert.deepEqual([await members(local), await members(remote)], [['review'], ['review']]);

        // A failed store keeps every list the stored data still names.
        const failing = { ...review, queueName: name, id: 'review', data: review.data, updateData: async () => { throw new Error('redis write failed'); } };
        await assert.rejects(persistAgentCapacityDeferral({ job: failing as never, error: new AgentCapacityError(['remote-llama']), correlatedLogger: log }), /redis write failed/);
        assert.deepEqual([await members(local), await members(remote)], [['review'], ['review']]);

        // Re-entered after local-llama freed: now only remote-llama blocks it, so it leaves local-llama's list.
        await persistAgentCapacityDeferral({ job: review as never, error: new AgentCapacityError(['remote-llama']), correlatedLogger: log });
        assert.deepEqual((await queue.getJob('review'))!.data.agentCapacityAliases, ['remote-llama']);
        assert.deepEqual([await members(local), await members(remote)], [[], ['review']]);
        assert.equal(await redis!.zscore(remote, JSON.stringify([name, 'review'])) !== null, true, 'keeps its place on the alias it still waits for');

        // An obsolete entry the reconciliation missed, older than a real local-llama waiter: the wakeup drops it
        // and promotes the real waiter. One that is not delayed may be joining the list right now: kept, not counted.
        const waiter = await queue.add('x', {}, { jobId: 'local-only', delay: 60_000 });
        await waiter.updateData({ agentCapacityAliases: ['local-llama'] });
        const entering = await queue.add('x', { agentCapacityAliases: ['remote-llama'] }, { jobId: 'entering' });
        await redis!.zadd(local, 1, JSON.stringify([name, 'review']), 2, JSON.stringify([name, 'entering']), 3, JSON.stringify([name, 'local-only']));
        await heldLocal.finish();
        assert.equal(await wakeAgentCapacityWaiters('local-llama'), 1);
        assert.equal(await waiter.isDelayed(), false, 'the real waiter is woken');
        assert.equal(await (await queue.getJob('review'))!.isDelayed(), true, 'the review still waits for remote-llama');
        assert.equal(await entering.isDelayed(), false);
        assert.deepEqual(await members(local), ['entering', 'local-only']);
    } finally {
        await redis!.del(local, remote);
        await queue.close();
        await heldLocal.finish().catch(() => {});
        await heldRemote.finish().catch(() => {});
    }
});

test('a lost race at the authoritative acquire: a short wait is admitted, a long one becomes a deferral for deferrable jobs only', integration(), async () => {
    const held = await holder('local-llama');
    try {
        // Deferrable job context: the alias-ceiling wait is bounded, the launch leaves no holder.
        const started = Date.now();
        await assert.rejects(runWithAgentCapacityContext({ raceWaitMs: 150 }, () => holder('local-llama')),
            (error: unknown) => error instanceof AgentCapacityError && error.aliases[0] === 'local-llama');
        assert.ok(Date.now() - started >= 150);
        assert.equal(Object.keys(await redis!.hgetall(agentAdmissionKeys(instanceId)[0])).length, 1, 'no reservation leaked');

        // A short wait inside the bound is simply admitted.
        const short = runWithAgentCapacityContext({ raceWaitMs: 5_000 }, () => holder('local-llama'));
        await delay(100);
        await held.finish();
        const admitted = await short;
        await admitted.finish();

        // No queue job (chat, planner, ...): it keeps waiting until the caller's own timeout, then reports a capacity wait.
        const again = await holder('local-llama');
        const controller = new AbortController();
        const timeoutReason = new Error('Command timed out after 200ms');
        setTimeout(() => controller.abort(timeoutReason), 200);
        await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'local-llama', client: redis!, docker: docker(), config: resolveAgentRunAdmission()!, pollMs: 10, signal: controller.signal, timeoutReason }),
            (error: unknown) => error instanceof AgentCapacityWaitTimeoutError && /Timed out waiting for agent capacity: 'local-llama' \(limit 1\)/.test((error as Error).message));
        // A cancellation is still reported as a cancellation.
        const cancelled = new AbortController();
        setTimeout(() => cancelled.abort(new Error('stopped by user')), 50);
        await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'local-llama', client: redis!, docker: docker(), config: resolveAgentRunAdmission()!, pollMs: 10, signal: cancelled.signal, timeoutReason }), /stopped by user/);
        await again.finish();
    } finally {
        await held.finish().catch(() => {});
    }
});

test('a holder whose process died is recovered by the deferred jobs of its alias, never blocking it forever', integration(), async () => {
    const name = `agent-capacity-abandoned-${run}`;
    queues.push(name);
    const queue = new Queue(name, { connection: redis! });
    const [holdersKey] = agentAdmissionKeys(instanceId);
    assert.equal(await redis!.hlen(holdersKey), 0);
    const events: string[] = [];
    const recording = (prefix: string): AdmissionDocker => {
        let count = 0;
        return {
            daemon: async () => 'test', assertEmpty: async () => {},
            create: async () => { const id = `${prefix}-${++count}`; events.push(`create ${id}`); return id; },
            remove: async id => { events.push(`remove ${id}`); },
        };
    };
    // The holder's process dies: its renewal never completes and it never calls finish().
    const frozen = new Proxy(redis!, { get: (target, key) => key === 'eval'
        ? (script: string, keys: number, ...args: (string | number)[]) => args[2] === 'renew' ? new Promise<never>(() => {}) : target.eval(script, keys, ...args)
        : Reflect.get(target, key, target) });
    const lease = 1_500;
    await prepareAdmittedAgent(['run', 'agent'], { agentAlias: 'local-llama', client: frozen, docker: recording('dead'), config: resolveAgentRunAdmission()!, pollMs: 10, leaseMs: lease });
    const abandonedAt = Date.now();
    const { tasks, stateManager } = timeline();
    const ran: string[] = [];
    const workerConnection = redis!.duplicate();
    let worker: Worker | undefined;
    try {
        assert.equal(await agentAliasHasCapacity('local-llama'), false, 'a live holder fills the ceiling');
        worker = new Worker(name, (job: Job<{ alias: string }>) => deferCapacityJob(job, async () => {
            try {
                await checkJobAgentCapacity(job, [{ agentAlias: job.data.alias }], { registry });
                await admitAgentCapacity(job);
            } catch (error) {
                if (isAgentCapacityRefusal(error)) await persistAgentCapacityDeferral({ job, error, stateManager: stateManager as never, taskId: job.id!, correlatedLogger: log });
                throw error;
            }
            const admitted = await prepareAdmittedAgent(['run', 'agent'], { agentAlias: job.data.alias, client: redis!, docker: recording(job.id!), config: resolveAgentRunAdmission()!, pollMs: 10 });
            await admitted.finish();
            ran.push(job.id!);
            return 'done';
        }), { connection: workerConnection, concurrency: 1 });
        await queue.add('local', { alias: 'local-llama' }, { attempts: 3, removeOnComplete: false, jobId: 'A1' });
        await until(async () => (await queue.getJob('A1'))!.data.agentCapacityDeferrals === 1 && await (await queue.getJob('A1'))!.isDelayed(), 8_000, 'a deferral while the holder is live');
        assert.equal(await wakeAgentCapacityWaiters('local-llama'), 0, 'no slot to wake while the holder is live');

        // The lease expires. Nothing releases the holder: expiry frees no capacity, and its process is gone.
        await delay(Math.max(0, abandonedAt + lease + 100 - Date.now()));
        assert.equal(await redis!.hlen(holdersKey), 1, 'the abandoned holder still occupies its slot');
        assert.equal(await agentAliasHasCapacity('local-llama'), true, 'only recovery can free it, so jobs must reach the acquire');
        assert.equal(await wakeAgentCapacityWaiters('local-llama'), 1, 'a wakeup counts it as recoverable too');

        // The woken (or backed-off) job reaches the acquire, recovers the holder and runs.
        await until(() => ran.includes('A1'), 8_000, 'the deferred job after recovery');
        assert.ok(events.indexOf('remove dead-1') >= 0 && events.indexOf('remove dead-1') < events.indexOf('create A1-1'), 'the dead container is removed before the slot is reused');
        const a1 = (await queue.getJob('A1'))!;
        assert.equal(a1.attemptsMade, 1);
        assert.equal(a1.data.agentCapacityDeferrals, undefined);
        assert.equal(tasks.get('A1')!.history.filter(row => row.metadata?.agentCapacityDeferrals).length, 1);

        // Later jobs of the alias are not deferred at all.
        await queue.add('local', { alias: 'local-llama' }, { attempts: 3, removeOnComplete: false, jobId: 'A2' });
        await until(() => ran.includes('A2'), 8_000, 'a later job');
        assert.equal((await queue.getJob('A2'))!.data.agentCapacityDeferrals, undefined);
        assert.equal(await redis!.hlen(holdersKey), 0, 'no holder left behind');
    } finally {
        await worker?.close(true);
        workerConnection.disconnect();
        await queue.close();
    }
});

test('a capacity wait is never a provider failure and never triggers replacement', () => {
    const refusal = new AgentCapacityError(['local-llama'], { 'local-llama': 1 });
    assert.equal(isAgentExecutionFailure(markAgentExecutionFailure(refusal)), false);
    assert.equal(isAgentExecutionFailure(markAgentExecutionFailure(new AgentCapacityWaitTimeoutError('local-llama', 1))), false);
    assert.equal(isTransientProviderError(refusal), false);
    assert.equal(isTransientProviderError("Timed out waiting for agent capacity: 'local-llama' (limit 1) stayed at its ceiling"), false);
    // Ordinary provider failures are still tagged.
    assert.equal(isAgentExecutionFailure(markAgentExecutionFailure(new Error('502 Bad Gateway'))), true);
});

test('with no per-agent policy no job is checked, deferred or modified', async () => {
    const saved = process.env.PROPR_AGENT_RUN_ALIAS_LIMITS;
    delete process.env.PROPR_AGENT_RUN_ALIAS_LIMITS;
    try {
        const writes: unknown[] = [];
        const job = { data: { alias: 'local-llama' }, updateData: async (data: unknown) => { writes.push(data); } };
        const unused = { beginRoutingSession: () => assert.fail('no routing without a policy') };
        assert.equal(await checkJobAgentCapacity(job as never, [{ agentAlias: 'local-llama' }], { registry: unused as never }), undefined);
        await admitAgentCapacity(job as never);
        assert.deepEqual(writes, []);
    } finally {
        if (saved !== undefined) process.env.PROPR_AGENT_RUN_ALIAS_LIMITS = saved;
    }
});
