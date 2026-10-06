import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
        await replacement.promptHandoff.beforeStart();
        replacement.promptHandoff.received();
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

test('a replacement run that fails before its prompt reaches an agent returns the carried steers', async () => {
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
        await database('tasks').insert({ task_id: 'task-prepare' });
        const redisClient = { async set() { return 'OK'; }, async del() { return 1; } };
        const claude = { steeringCapability: 'live' as const, config: { alias: 'claude-default', type: 'claude' as const } };
        await createTaskSteer(database, {
            taskId: 'task-prepare', runKey: 'run:earlier', author: 'octocat', authorSource: 'session',
            message: 'Keep the public API unchanged',
        });

        // Preparation (git access, reasoning level) failed: no agent process was started.
        const failed = await startTaskSteeringRun({ taskId: 'task-prepare', agent: claude, redisClient, db: database });
        assert.match(failed.promptContext, /Keep the public API unchanged/);
        await failed.finish();
        const [pending] = await listTaskSteers(database, 'task-prepare');
        assert.equal(pending!.deliveredAt, null);
        assert.equal(pending!.delivery, null);
        assert.equal((await database('task_history')).length, 0, 'no delivery is reported');

        // The next run receives it; once its agent received it, it is not replayed even if that run fails.
        const next = await startTaskSteeringRun({ taskId: 'task-prepare', agent: claude, redisClient, db: database });
        assert.match(next.promptContext, /Keep the public API unchanged/);
        await next.promptHandoff.beforeStart();
        next.promptHandoff.received();
        next.promptHandoff.received();
        await next.finish();
        const [delivered] = await listTaskSteers(database, 'task-prepare');
        assert.equal(delivered!.delivery, 'replacement_prompt');
        assert.ok(delivered!.acknowledgedAt, 'the agent output confirmed the delivery');
        const timeline = await database('task_history').select('reason');
        assert.equal(timeline.length, 1);
        assert.match(timeline[0].reason, /carried into this run's prompt/);
        const after = await startTaskSteeringRun({ taskId: 'task-prepare', agent: claude, redisClient, db: database });
        assert.equal(after.promptContext, '');
        await after.finish();
    } finally {
        await database.destroy();
    }
});

test('carried steers survive a worker that died, or an agent process that failed to start, before the handoff', async () => {
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
        await database('tasks').insert({ task_id: 'task-crash' });
        const redisClient = { async set() { return 'OK'; }, async del() { return 1; } };
        const claude = { steeringCapability: 'live' as const, config: { alias: 'claude-default', type: 'claude' as const } };
        await createTaskSteer(database, {
            taskId: 'task-crash', runKey: 'run:earlier', author: 'octocat', authorSource: 'session',
            message: 'Keep the public API unchanged',
        });

        // The worker claims the steer for its prompt, then dies: finish() never runs.
        const crashed = await startTaskSteeringRun({ taskId: 'task-crash', agent: claude, redisClient, db: database });
        assert.match(crashed.promptContext, /Keep the public API unchanged/);
        const [abandoned] = await listTaskSteers(database, 'task-crash');
        assert.equal(abandoned!.delivery, null, 'a claim being prepared is not reported as delivered');

        // The next worker reclaims it, but spawn() returns a child that then fails to start.
        const spawnFailed = await startTaskSteeringRun({ taskId: 'task-crash', agent: claude, redisClient, db: database });
        assert.match(spawnFailed.promptContext, /Keep the public API unchanged/);
        await assert.rejects(executeDockerCommand('/nonexistent/propr-agent-binary', [], {
            timeout: 10_000, stdinData: spawnFailed.promptContext, promptHandoff: spawnFailed.promptHandoff,
        }), /ENOENT/);
        await spawnFailed.finish();
        const [released] = await listTaskSteers(database, 'task-crash');
        assert.equal(released!.deliveredAt, null);
        assert.equal(released!.delivery, null);
        assert.equal((await database('task_history')).length, 0, 'no delivery is reported');

        // A run whose agent answered records the delivery; it is never replayed afterwards.
        const started = await startTaskSteeringRun({ taskId: 'task-crash', agent: claude, redisClient, db: database });
        assert.match(started.promptContext, /Keep the public API unchanged/);
        const result = await executeDockerCommand(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { console.log("{}"); process.exit(0); });'], {
            timeout: 10_000, stdinData: started.promptContext, promptHandoff: started.promptHandoff,
        });
        assert.equal(result.exitCode, 0);
        await started.finish();
        const [delivered] = await listTaskSteers(database, 'task-crash');
        assert.equal(delivered!.delivery, 'replacement_prompt');
        const after = await startTaskSteeringRun({ taskId: 'task-crash', agent: claude, redisClient, db: database });
        assert.equal(after.promptContext, '');
        await after.finish();
    } finally {
        await database.destroy();
    }
});

async function steeringDatabase(taskId: string) {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
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
    await database('tasks').insert({ task_id: taskId });
    await createTaskSteer(database, {
        taskId, runKey: 'run:earlier', author: 'octocat', authorSource: 'session', message: 'Keep the public API unchanged',
    });
    return database;
}

const steeringRedis = { async set() { return 'OK'; }, async del() { return 1; } };
const steerableClaude = { steeringCapability: 'live' as const, config: { alias: 'claude-default', type: 'claude' as const } };

/** A `docker` client that starts, reads its input, and exits on a daemon failure, or runs a shell body. */
async function fakeDocker(body: string): Promise<{ docker: string; dir: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'propr-fake-docker-'));
    const docker = path.join(dir, 'docker');
    await writeFile(docker, `#!/bin/sh\n${body}\n`);
    await chmod(docker, 0o755);
    return { docker, dir };
}

test('a started docker client whose daemon fails before any container runs returns the carried steers', async () => {
    const database = await steeringDatabase('task-daemon');
    const { docker, dir } = await fakeDocker('cat >/dev/null\necho "docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2\nexit 125');
    try {
        const run = await startTaskSteeringRun({ taskId: 'task-daemon', agent: steerableClaude, redisClient: steeringRedis, db: database });
        assert.match(run.promptContext, /Keep the public API unchanged/);
        const result = await executeDockerCommand(docker, ['run', '-i', '--rm', 'agent-image'], {
            timeout: 10_000, stdinData: run.promptContext, promptHandoff: run.promptHandoff,
        });
        assert.equal(result.exitCode, 125);
        await run.finish();
        const [released] = await listTaskSteers(database, 'task-daemon');
        assert.equal(released!.deliveredAt, null);
        assert.equal(released!.delivery, null);
        assert.equal((await database('task_history')).length, 0, 'no delivery is reported');

        const next = await startTaskSteeringRun({ taskId: 'task-daemon', agent: steerableClaude, redisClient: steeringRedis, db: database });
        assert.match(next.promptContext, /Keep the public API unchanged/, 'a replacement run still receives it');
        await next.finish();
    } finally {
        await database.destroy();
        await rm(dir, { recursive: true, force: true });
    }
});

test('a container that may have run without answering is never replayed nor reported as confirmed', async () => {
    const database = await steeringDatabase('task-silent');
    const { docker, dir } = await fakeDocker('cat >/dev/null\nexit 1');
    try {
        const run = await startTaskSteeringRun({ taskId: 'task-silent', agent: steerableClaude, redisClient: steeringRedis, db: database });
        const result = await executeDockerCommand(docker, ['run', '-i', '--rm', 'agent-image'], {
            timeout: 10_000, stdinData: run.promptContext, promptHandoff: run.promptHandoff,
        });
        assert.equal(result.exitCode, 1);
        await run.finish();
        const [uncertain] = await listTaskSteers(database, 'task-silent');
        assert.equal(uncertain!.delivery, 'replacement_prompt');
        assert.equal(uncertain!.acknowledgedAt, null);
        assert.equal((await database('task_history')).length, 0, 'no confirmed delivery is reported');
        const next = await startTaskSteeringRun({ taskId: 'task-silent', agent: steerableClaude, redisClient: steeringRedis, db: database });
        assert.equal(next.promptContext, '');
        await next.finish();
    } finally {
        await database.destroy();
        await rm(dir, { recursive: true, force: true });
    }
});

test('the handoff is committed before the agent process starts, so a worker that dies afterwards never replays it', async () => {
    const database = await steeringDatabase('task-exposed');
    try {
        const run = await startTaskSteeringRun({ taskId: 'task-exposed', agent: steerableClaude, redisClient: steeringRedis, db: database });
        let deliveryAtStart: string | null | undefined;
        const observed = {
            ...run.promptHandoff,
            beforeStart: async () => {
                await run.promptHandoff.beforeStart();
                [{ delivery: deliveryAtStart }] = await listTaskSteers(database, 'task-exposed') as [{ delivery: string | null }];
            },
        };
        // The agent read its prompt; the worker then dies: received bookkeeping and finish() never run.
        await executeDockerCommand(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], {
            timeout: 10_000, stdinData: run.promptContext, promptHandoff: { ...observed, received: () => undefined },
        });
        assert.equal(deliveryAtStart, 'replacement_prompt', 'persisted before the process was started');
        const next = await startTaskSteeringRun({ taskId: 'task-exposed', agent: steerableClaude, redisClient: steeringRedis, db: database });
        assert.equal(next.promptContext, '', 'the next run does not send it again');
        await next.finish();
    } finally {
        await database.destroy();
    }
});

test('a handoff that cannot be persisted starts no agent with the carried steers', async () => {
    const database = await steeringDatabase('task-unpersisted');
    const marker = path.join(isolatedDbDir, 'unpersisted-agent-started');
    try {
        const run = await startTaskSteeringRun({ taskId: 'task-unpersisted', agent: steerableClaude, redisClient: steeringRedis, db: database });
        // The database stops accepting the handoff after the claim.
        await database.raw(`CREATE TRIGGER reject_handoff BEFORE UPDATE ON task_steers
            WHEN NEW.delivery = 'replacement_prompt' BEGIN SELECT RAISE(ABORT, 'database unavailable'); END`);
        await assert.rejects(executeDockerCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], {
            timeout: 10_000, stdinData: run.promptContext, promptHandoff: run.promptHandoff,
        }), /database unavailable/);
        assert.equal(existsSync(marker), false, 'the prompt carrying the steers was never exposed');
        await database.raw('DROP TRIGGER reject_handoff');
        await run.finish();
        const next = await startTaskSteeringRun({ taskId: 'task-unpersisted', agent: steerableClaude, redisClient: steeringRedis, db: database });
        assert.match(next.promptContext, /Keep the public API unchanged/, 'still recoverable');
        await next.finish();
    } finally {
        await database.destroy();
    }
});
