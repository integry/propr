import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import knex from 'knex';
import { IDLE_PARTICIPANTS_REDIS_KEY, IDLE_STATUS_REDIS_KEY, resolveIdleShutdownConfig, type IdleShutdownConfig, type IdleShutdownStatus } from '@propr/shared';
import { emptyIdleSignals, evaluateIdle, type IdleSignals } from '../src/idle/idleDetector.js';
import { IdleShutdownController, type IdleShutdownRequest } from '../src/idle/idleShutdownController.js';
import {
    collectActivitySignals,
    collectDatabaseSignals,
    collectIdleSignals,
    collectQueueSignals,
    type IdleRedis,
} from '../src/idle/idleSignals.js';
import { idleActivityKey } from '../src/idle/idleActivity.js';

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 24, 8, 0, 0);

/** In-memory stand-in for the Redis commands the idle code uses. */
class FakeRedis implements IdleRedis {
    strings = new Map<string, string>();
    lists = new Map<string, number>();
    zsets = new Map<string, Array<[string, number]>>();

    async scan(_cursor: string, _match: 'MATCH', pattern: string): Promise<[string, string[]]> {
        const regex = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        const keys = [...this.strings.keys(), ...this.lists.keys(), ...this.zsets.keys()].filter(key => regex.test(key));
        return ['0', keys];
    }
    async llen(key: string) { return this.lists.get(key) ?? 0; }
    async zcard(key: string) { return this.zsets.get(key)?.length ?? 0; }
    async zrange(key: string, start: number, stop: number): Promise<string[]> {
        const entries = [...(this.zsets.get(key) ?? [])].sort((a, b) => a[1] - b[1]).slice(start, stop + 1);
        return entries.flatMap(([member, score]) => [member, String(score)]);
    }
    hashes = new Map<string, Map<string, string>>();
    async get(key: string) { return this.strings.get(key) ?? null; }
    async set(key: string, value: string) { this.strings.set(key, value); return 'OK'; }
    async hgetall(key: string) { return Object.fromEntries(this.hashes.get(key) ?? []); }
    async hset(key: string, field: string, value: string) { if (!this.hashes.has(key)) this.hashes.set(key, new Map()); this.hashes.get(key)!.set(field, value); return 1; }
    async hdel(key: string, field: string) { return this.hashes.get(key)?.delete(field) ? 1 : 0; }
}

function controllerHarness(options: { signals: () => IdleSignals; config?: IdleShutdownConfig; resolveConfig?: () => Promise<IdleShutdownConfig>; onIdle?: (request: IdleShutdownRequest) => Promise<boolean> }) {
    let now = START;
    const redis = new FakeRedis();
    const requests: IdleShutdownRequest[] = [];
    const controller = new IdleShutdownController({
        redis,
        now: () => now,
        resolveConfig: options.resolveConfig ?? (async () => options.config ?? resolveIdleShutdownConfig({ PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: '15m' })),
        collect: async () => options.signals(),
        onIdle: async request => { requests.push(request); return options.onIdle ? options.onIdle(request) : true; },
    });
    return {
        controller,
        redis,
        requests,
        advance(ms: number) { now += ms; },
        status(): IdleShutdownStatus { return JSON.parse(redis.strings.get(IDLE_STATUS_REDIS_KEY) ?? 'null'); },
    };
}

test('an idle instance stops only after the whole window', async () => {
    const harness = controllerHarness({ signals: emptyIdleSignals });
    await harness.controller.tick();
    assert.equal(harness.status().idle, true);
    assert.equal(harness.status().shutdownAt, new Date(START + 15 * MINUTE).toISOString());
    harness.advance(14 * MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 0);
    harness.advance(MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].idleForMs, 15 * MINUTE);
    // Shutting down: no further ticks run.
    harness.advance(MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 1);
});

const busyCases: Array<[string, Partial<IdleSignals>]> = [
    ['a queued job', { queues: [{ name: 'github-issue-processor', waiting: 1, active: 0, prioritized: 0, waitingChildren: 0, paused: 0 }] }],
    ['an open Web UI session', { uiSessions: 1 }],
    ['a schedule due within the window', { scheduled: [{ kind: 'automation' as const, dueAt: START + 20 * MINUTE, detail: 'scheduled automation' }] }],
];
for (const [label, busy] of busyCases) {
    test(`${label} prevents shutdown`, async () => {
        const harness = controllerHarness({ signals: () => ({ ...emptyIdleSignals(), ...busy }) });
        for (let minute = 0; minute <= 30; minute += 1) {
            await harness.controller.tick();
            harness.advance(MINUTE);
        }
        assert.equal(harness.requests.length, 0);
        assert.equal(harness.status().idle, false);
        assert.ok(harness.status().blockers.length > 0);
    });
}

test('activity in the middle of the window restarts it', async () => {
    let busy = false;
    const harness = controllerHarness({ signals: () => ({ ...emptyIdleSignals(), uiSessions: busy ? 1 : 0 }) });
    await harness.controller.tick();
    harness.advance(10 * MINUTE);
    busy = true;
    await harness.controller.tick();
    busy = false;
    harness.advance(MINUTE);
    await harness.controller.tick();
    harness.advance(14 * MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 0);
    harness.advance(MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 1);
});

test('work that appears at the final check cancels the shutdown', async () => {
    let calls = 0;
    // Idle on every regular tick, busy on the re-check right before stopping.
    const harness = controllerHarness({ signals: () => ({ ...emptyIdleSignals(), runningGoals: calls++ === 1 ? 1 : 0 }) });
    await harness.controller.tick();
    harness.advance(15 * MINUTE);
    calls = 0;
    await harness.controller.tick();
    assert.equal(harness.requests.length, 0);
});

test('an aborted drain keeps the instance running and restarts the window', async () => {
    const harness = controllerHarness({ signals: emptyIdleSignals, onIdle: async () => false });
    await harness.controller.tick();
    harness.advance(15 * MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 1);
    harness.advance(MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 1, 'the window starts over after an abort');
    harness.advance(15 * MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 2);
});

test('disabled (the default) publishes status but never stops', async () => {
    const harness = controllerHarness({ signals: emptyIdleSignals, config: resolveIdleShutdownConfig({}) });
    for (let i = 0; i < 5; i += 1) {
        await harness.controller.tick();
        harness.advance(30 * MINUTE);
    }
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.status().enabled, false);
    assert.equal(harness.status().idle, true);
    assert.equal(harness.status().shutdownAt, null);
});

test('a setting that cannot be read prohibits shutdown and starts the idle period over', async () => {
    const enabled = resolveIdleShutdownConfig({ PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: '15m' });
    let readable = true;
    const harness = controllerHarness({
        signals: emptyIdleSignals,
        resolveConfig: async () => { if (!readable) throw new Error('Invalid JSON in stored setting'); return enabled; },
    });
    await harness.controller.tick();
    harness.advance(14 * MINUTE);
    readable = false;
    await harness.controller.tick();
    harness.advance(5 * MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 0, 'no shutdown on a cached setting, though the window has passed');
    const status = harness.status();
    assert.equal(status.enabled, true, 'the last known setting is still shown');
    assert.equal(status.idle, false);
    assert.equal(status.idleSince, null);
    assert.equal(status.shutdownAt, null);
    assert.ok(status.blockers.some(blocker => blocker.signal === 'unavailable' && /idle shutdown setting/.test(blocker.detail)), 'the unreadable setting is a blocker');

    // Readable again: a whole new window, counted from now.
    readable = true;
    await harness.controller.tick();
    assert.equal(harness.status().idleSince, new Date(START + 19 * MINUTE).toISOString());
    harness.advance(14 * MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 0);
    harness.advance(MINUTE);
    await harness.controller.tick();
    assert.equal(harness.requests.length, 1);
});

test('the final check before stopping re-reads the setting', async () => {
    const enabled = resolveIdleShutdownConfig({ PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: '15m' });
    let reads = 0;
    let failAt = Infinity;
    const harness = controllerHarness({
        signals: emptyIdleSignals,
        resolveConfig: async () => { reads += 1; if (reads >= failAt) throw new Error('Invalid JSON in stored setting'); return enabled; },
    });
    await harness.controller.tick();
    harness.advance(15 * MINUTE);
    // The tick's own read succeeds; the read right before stopping fails.
    failAt = reads + 2;
    await harness.controller.tick();
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.status().idle, true);
});

test('queue collector finds every queue and the earliest delayed job', async () => {
    const redis = new FakeRedis();
    redis.strings.set('bull:github-issue-processor:meta', '{}');
    redis.strings.set('bull:agent-runtime-build:meta', '{}');
    redis.lists.set('bull:agent-runtime-build:active', 1);
    const due = START + 3 * 60 * MINUTE;
    redis.zsets.set('bull:github-issue-processor:delayed', [['job-2', (due + 5000) * 0x1000], ['job-1', due * 0x1000 + 7]]);
    const result = await collectQueueSignals(redis);
    assert.deepEqual(result.queues.map(queue => [queue.name, queue.active]), [['agent-runtime-build', 1], ['github-issue-processor', 0]]);
    assert.deepEqual(result.scheduled, [{ kind: 'delayed_job', dueAt: due, detail: 'delayed job in github-issue-processor' }]);
});

function registerApi(redis: FakeRedis, id: string, seenAt: number) {
    const participant = { role: 'api', id, host: 'elsewhere', pid: 1, pidNamespace: null, bootId: null, startedAt: START - MINUTE, seenAt };
    return redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, `api:${id}`, JSON.stringify(participant));
}

test('activity collector sums every API process with a current record', async () => {
    const redis = new FakeRedis();
    await registerApi(redis, 'a', START);
    await registerApi(redis, 'b', START);
    redis.strings.set(idleActivityKey('api', 'a'), JSON.stringify({ uiSessions: 1, mcpRequests: 0, httpRequests: 2, lastRequestAt: START, publishedAt: START }));
    redis.strings.set(idleActivityKey('api', 'b'), JSON.stringify({ uiSessions: 2, mcpRequests: 1, httpRequests: 0, lastRequestAt: START + 5, publishedAt: START }));
    assert.deepEqual(await collectActivitySignals(redis, { now: START + 1_000 }), { uiSessions: 3, mcpRequests: 1, httpRequests: 2, lastActivityAt: START + 5, unavailable: [] });
});

test('a registered API process without a current, well-formed record is unavailable, not idle', async () => {
    const redis = new FakeRedis();
    for (const id of ['expired', 'stale', 'garbage', 'partial']) await registerApi(redis, id, START);
    // `expired`: the key is gone (TTL ran out while the process was stalled).
    redis.strings.set(idleActivityKey('api', 'stale'), JSON.stringify({ uiSessions: 0, mcpRequests: 0, httpRequests: 0, lastRequestAt: 0, publishedAt: START - 2 * MINUTE }));
    redis.strings.set(idleActivityKey('api', 'garbage'), 'garbage');
    redis.strings.set(idleActivityKey('api', 'partial'), JSON.stringify({ uiSessions: 0, publishedAt: START }));
    const result = await collectActivitySignals(redis, { now: START });
    assert.deepEqual(result.unavailable.sort(), [
        'API activity from api:expired (no current record)',
        'API activity from api:garbage (no current record)',
        'API activity from api:partial (no current record)',
        'API activity from api:stale (no current record)',
    ]);
    const merged = await collectIdleSignals({ activity: async () => result });
    assert.equal(evaluateIdle(merged, { now: START, windowMs: 15 * MINUTE }).idle, false);
});

test('an API process confirmed stopped on this host is no longer expected', async () => {
    const redis = new FakeRedis();
    const local = { host: 'here', pidNamespace: 'pid:[1]', bootId: 'boot' };
    const participant = { role: 'api', id: 'gone', host: 'here', pid: 4242, pidNamespace: 'pid:[1]', bootId: 'boot', startedAt: START - MINUTE, seenAt: START - 5 * MINUTE };
    await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'api:gone', JSON.stringify(participant));
    assert.deepEqual((await collectActivitySignals(redis, { now: START, local, isGone: () => false })).unavailable, ['API activity from api:gone (no current record)']);
    assert.deepEqual((await collectActivitySignals(redis, { now: START, local, isGone: pid => pid === 4242 })).unavailable, []);
    // Another pid namespace (another container): a pid lookup proves nothing.
    assert.deepEqual((await collectActivitySignals(redis, { now: START, local: { ...local, pidNamespace: 'pid:[2]' }, isGone: () => true })).unavailable.length, 1);
});

test('an API process of an earlier boot of this installation is no longer expected', async () => {
    const redis = new FakeRedis();
    const local = { host: 'here', pidNamespace: 'pid:[1]', bootId: 'boot-now', instanceId: 'instance-a', bootTime: START - 2 * MINUTE };
    const participant = { role: 'api', id: 'before-reboot', host: 'here', pid: 4242, pidNamespace: 'pid:[1]', bootId: 'boot-before', instanceId: 'instance-a', startedAt: START - 60 * MINUTE, seenAt: START - 5 * MINUTE };
    await redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, 'api:before-reboot', JSON.stringify(participant));
    const isGone = () => false;
    assert.deepEqual((await collectActivitySignals(redis, { now: START, local, isGone })).unavailable, []);
    // Another installation's process with the same history stays expected.
    assert.equal((await collectActivitySignals(redis, { now: START, local: { ...local, instanceId: 'instance-b' }, isGone })).unavailable.length, 1);
});

test('a failing source is reported as unavailable', async () => {
    const result = await collectIdleSignals({
        ok: async () => ({ uiSessions: 1 }),
        broken: async () => { throw new Error('down'); },
    });
    assert.equal(result.uiSessions, 1);
    assert.deepEqual(result.unavailable, ['broken']);
});

const directory = await mkdtemp(path.join(tmpdir(), 'idle-db-'));
const database = knex({ client: 'better-sqlite3', connection: { filename: path.join(directory, 'idle.sqlite') }, useNullAsDefault: true });
after(async () => {
    await database.destroy();
    await rm(directory, { recursive: true, force: true });
});

test('database collector counts active runs, goals and handoffs and finds scheduled automations', async () => {
    await database.schema.createTable('agent_definitions', table => {
        table.string('id'); table.boolean('schedule_enabled'); table.boolean('enabled'); table.bigInteger('next_run_at'); table.bigInteger('pending_schedule_slot');
    });
    await database.schema.createTable('agent_runs', table => { table.string('id'); table.string('state'); table.bigInteger('deferred_until'); });
    await database.schema.createTable('goals', table => { table.string('goal_id'); table.string('desired_state'); table.string('result_state'); });
    await database.schema.createTable('pr_followup_handoffs', table => { table.string('task_id'); table.string('status'); });

    assert.deepEqual(await collectDatabaseSignals(database), { activeAgentRuns: 0, runningGoals: 0, followupHandoffs: 0, scheduled: [] });

    await database('agent_definitions').insert([
        { id: 'a', schedule_enabled: true, enabled: true, next_run_at: START + 120 * MINUTE },
        { id: 'b', schedule_enabled: true, enabled: true, next_run_at: START + 60 * MINUTE },
        { id: 'c', schedule_enabled: false, enabled: true, next_run_at: START + MINUTE },
    ]);
    await database('agent_runs').insert([
        { id: '1', state: 'running' }, { id: '2', state: 'awaiting_approval' }, { id: '3', state: 'completed' },
        { id: '4', state: 'deferred', deferred_until: START + 30 * MINUTE },
    ]);
    await database('goals').insert([{ goal_id: 'g1', desired_state: 'running', result_state: null }, { goal_id: 'g2', desired_state: 'running', result_state: 'completed' }]);
    await database('pr_followup_handoffs').insert([{ task_id: 't1', status: 'active' }, { task_id: 't2', status: 'awaiting_operator' }]);

    const result = await collectDatabaseSignals(database);
    assert.equal(result.activeAgentRuns, 1, 'awaiting approval waits for a person and does not count');
    assert.equal(result.runningGoals, 1);
    assert.equal(result.followupHandoffs, 1);
    assert.deepEqual(result.scheduled.map(item => [item.kind, item.dueAt]).sort((a, b) => Number(a[1]) - Number(b[1])), [
        ['deferred_automation_run', START + 30 * MINUTE],
        ['automation', START + 60 * MINUTE],
    ]);
});
