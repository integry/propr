import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import knex from 'knex';
import { IDLE_STATUS_REDIS_KEY, resolveIdleShutdownConfig, type IdleShutdownConfig, type IdleShutdownStatus } from '@propr/shared';
import { emptyIdleSignals, type IdleSignals } from '../src/idle/idleDetector.js';
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
    async get(key: string) { return this.strings.get(key) ?? null; }
    async set(key: string, value: string) { this.strings.set(key, value); return 'OK'; }
}

function controllerHarness(options: { signals: () => IdleSignals; config?: IdleShutdownConfig; onIdle?: (request: IdleShutdownRequest) => Promise<boolean> }) {
    let now = START;
    const redis = new FakeRedis();
    const requests: IdleShutdownRequest[] = [];
    const controller = new IdleShutdownController({
        redis,
        now: () => now,
        resolveConfig: async () => options.config ?? resolveIdleShutdownConfig({ PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: '15m' }),
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

test('activity collector sums every API process and ignores malformed keys', async () => {
    const redis = new FakeRedis();
    redis.strings.set(idleActivityKey('api', 'a'), JSON.stringify({ uiSessions: 1, mcpRequests: 0, httpRequests: 2, lastRequestAt: START, publishedAt: START }));
    redis.strings.set(idleActivityKey('api', 'b'), JSON.stringify({ uiSessions: 2, mcpRequests: 1, httpRequests: 0, lastRequestAt: START + 5, publishedAt: START }));
    redis.strings.set(idleActivityKey('api', 'c'), 'garbage');
    assert.deepEqual(await collectActivitySignals(redis), { uiSessions: 3, mcpRequests: 1, httpRequests: 2, lastActivityAt: START + 5 });
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
