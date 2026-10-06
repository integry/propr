import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, mock, test } from 'node:test';
import knex from 'knex';

class FakeRedis {
    status = 'ready';
    on() { return this; }
    async eval(_script: string, _keys: number, _data: string, _meta: string, text: string) { return text.length; }
    async get() { return null; }
    async quit() { return 'OK'; }
    disconnect() {}
}
mock.module('ioredis', { namedExports: { Redis: FakeRedis, default: FakeRedis } });

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const isolatedDbDir = await mkdtemp(path.join(tmpdir(), 'propr-task-steering-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(isolatedDbDir, 'propr.sqlite');

const { executeDockerCommand } = await import('../packages/core/src/claude/docker/dockerExecutor.js');
const { encodeClaudeUserMessage, isClaudeResultRecord } = await import('../packages/core/src/agents/impl/utils/claudeStreamInput.js');
const { closeConnection, createTaskSteer, listTaskSteers } = await import('@propr/core');
const { up: createTaskSteers } = await import('../packages/core/src/db/migrations/20261006000000_create_task_steers.js');
const { startTaskSteeringRun } = await import('../src/jobs/taskSteering.js');
const { taskSteeringRedisKey } = await import('@propr/shared');
type LiveInputMessage = import('../packages/core/src/claude/docker/dockerLiveInput.js').LiveInputMessage;

after(async () => {
    await closeConnection();
    await rm(isolatedDbDir, { recursive: true, force: true });
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDbFilename === undefined) delete process.env.DB_FILENAME;
    else process.env.DB_FILENAME = originalDbFilename;
});

test('the stall watchdog treats a delivered steer as activity', async () => {
    let remaining = 5;
    const source = {
        async claim(): Promise<LiveInputMessage[]> {
            if (remaining <= 0) return [];
            remaining -= 1;
            return [{ id: `steer-${remaining}`, text: 'Keep going with the plan' }];
        },
        async acknowledge() {},
        async release() {},
    };
    // A silent agent that only reads its input: without steers it would stall at 300ms.
    const agent = `
let received = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
  if (++received === 6) process.exit(0);
});
setTimeout(() => {}, 60_000);`;
    const trips: unknown[] = [];
    const result = await executeDockerCommand(process.execPath, ['-e', agent], {
        taskId: 'steer-watchdog-task', streamToRedis: true, preserveOutputOnTimeout: true, timeout: 30_000,
        watchdog: { stallTimeoutMs: 300, toolStallTimeoutMs: 1_500, degenerateOutputLimit: 5 },
        onWatchdogTrip: (_taskId: string, trip: unknown) => { trips.push(trip); },
        liveInput: {
            initialInput: encodeClaudeUserMessage('Implement the issue.'),
            source,
            encode: encodeClaudeUserMessage,
            endsInput: isClaudeResultRecord,
            pollIntervalMs: 100,
        },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.watchdogTrip, undefined);
    assert.equal(trips.length, 0);
});

test('a replacement run receives undelivered steers once and announces its capability', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await database.schema.createTable('tasks', table => { table.string('task_id', 255).primary(); });
        await database.schema.createTable('task_history', table => {
            table.increments('history_id').primary();
            table.string('task_id', 255).notNullable();
            table.string('state', 50).notNullable();
            table.timestamp('timestamp').notNullable();
            table.text('reason');
            table.json('metadata');
        });
        await createTaskSteers(database);
        await database('tasks').insert({ task_id: 'task-restart' });

        const redis = new Map<string, string>();
        const redisClient = {
            async set(key: string, value: string) { redis.set(key, value); return 'OK'; },
            async del(key: string) { redis.delete(key); return 1; },
        };
        const claude = { steeringCapability: 'live' as const, config: { alias: 'claude-default', type: 'claude' as const } };

        // The first run accepted a steer, then its container died before delivering it.
        const first = await startTaskSteeringRun({ taskId: 'task-restart', agent: claude, redisClient, db: database });
        assert.equal(first.promptContext, '');
        assert.ok(first.steering, 'a live agent receives a steering source');
        const announcement = JSON.parse(redis.get(taskSteeringRedisKey('task-restart'))!);
        assert.equal(announcement.capability, 'live');
        await createTaskSteer(database, {
            taskId: 'task-restart', runKey: announcement.runKey, author: 'octocat', authorSource: 'session',
            message: 'Keep the public API unchanged',
        });
        await first.finish();
        assert.equal(redis.has(taskSteeringRedisKey('task-restart')), false);

        // The replacement run carries it in its prompt; a further restart does not repeat it.
        const replacement = await startTaskSteeringRun({ taskId: 'task-restart', agent: claude, redisClient, db: database });
        assert.match(replacement.promptContext, /Operator input during the run/);
        assert.match(replacement.promptContext, /Keep the public API unchanged/);
        assert.deepEqual(await replacement.steering!.claim(), []);
        await replacement.finish();
        const again = await startTaskSteeringRun({ taskId: 'task-restart', agent: claude, redisClient, db: database });
        assert.equal(again.promptContext, '');
        await again.finish();

        const [steer] = await listTaskSteers(database, 'task-restart');
        assert.equal(steer!.delivery, 'replacement_prompt');
        const timeline = await database('task_history').select('reason');
        assert.equal(timeline.length, 1);
        assert.match(timeline[0].reason, /carried into this run's prompt/);

        // An agent without steering is announced so the API can reject with its capability.
        const opencode = { steeringCapability: 'none' as const, config: { alias: 'opencode-default', type: 'opencode' as const } };
        const unsteerable = await startTaskSteeringRun({ taskId: 'task-restart', agent: opencode, redisClient, db: database });
        assert.equal(unsteerable.steering, undefined);
        assert.equal(JSON.parse(redis.get(taskSteeringRedisKey('task-restart'))!).capability, 'none');
        await unsteerable.finish();
    } finally {
        await database.destroy();
    }
});
