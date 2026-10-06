import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { REDIS_CHANNELS } from '@propr/shared';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test';
import { closeEventPublisher, getEventPublisher, type EventPublisher } from '../src/utils/eventPublisher.js';
import { SilentRedis } from './silentRedisStub.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

let redisHost: string | undefined;
let redisPort: string | undefined;
let stub: SilentRedis;

async function elapsedMs(operation: () => Promise<unknown>): Promise<number> {
    const started = Date.now();
    await operation();
    return Date.now() - started;
}

async function publishNotification(): Promise<void> {
    await getEventPublisher().publishNotificationUpdate({
        change: 'dismissed',
        eventId: 'event-1',
        recipientIds: ['user-a'],
        repository: 'integry/propr',
        occurredAt: new Date().toISOString()
    });
}

beforeEach(async () => {
    redisHost = process.env.REDIS_HOST;
    redisPort = process.env.REDIS_PORT;
    stub = await SilentRedis.listen();
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = String(stub.port);
});

afterEach(async () => {
    await closeEventPublisher();
    await stub.goAway();
    if (redisHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = redisHost;
    if (redisPort === undefined) delete process.env.REDIS_PORT;
    else process.env.REDIS_PORT = redisPort;
});

describe('event publisher outage bounds', { concurrency: false }, () => {
    test('a publish to a Redis that never answers gives up instead of waiting', async () => {
        // The committed notification mutation behind this call must not be held
        // open for the length of the outage.
        const duration = await elapsedMs(publishNotification);

        assert.ok(duration < 5_000, `the publish blocked for ${duration}ms`);
    });

    test('a publish after the connection drops is dropped immediately', async () => {
        await publishNotification();
        await stub.goAway();
        // Let the client observe the closed socket before the next publish.
        await new Promise(resolve => setTimeout(resolve, 50));

        const duration = await elapsedMs(publishNotification);

        assert.ok(duration < 500, `the publish waited ${duration}ms on a disconnected client`);
    });

    test('a batch of publishes costs one timeout, not one per event', async () => {
        // A cleanup that closes many notifications announces each of them. The
        // first publish to a connected-but-silent Redis is enough evidence that
        // the connection is not answering; the rest of the batch must be dropped
        // instead of each waiting out its own deadline.
        const duration = await elapsedMs(async () => {
            for (let published = 0; published < 5; published += 1) await publishNotification();
        });

        assert.ok(duration < 2_500, `five publishes took ${duration}ms`);
    });

    test('shutdown does not wait on an unreachable Redis either', async () => {
        await publishNotification();
        await stub.goAway();

        const duration = await elapsedMs(closeEventPublisher);

        assert.ok(duration < 5_000, `closing the publisher took ${duration}ms`);
    });

    test('an idle publisher does not keep its process alive', async () => {
        // Publishing is best effort, so reaching a code path that publishes
        // must not become a shutdown obligation. Suites that merely exercise a
        // goal transition or a notification write do not know they published,
        // and when the connection was left holding the event loop open they
        // hung after their last assertion until the runner killed them.
        const exit = await runFixture('publishThenExit.ts', 30_000);

        assert.equal(
            exit.code,
            0,
            `the publishing process did not exit cleanly (${exit.reason})\n${exit.output}`
        );
    });
});

const lifecyclePublishes: Array<[string, (publisher: EventPublisher) => Promise<unknown>]> = [
    [REDIS_CHANNELS.TASKS, publisher => publisher.publishTaskUpdate({ taskId: 'task-1', state: 'completed' })],
    [REDIS_CHANNELS.DRAFTS, publisher => publisher.publishDraftUpdate({ draftId: 'draft-1', step: 'complete', status: 'completed' })],
    [REDIS_CHANNELS.INDEXING, publisher => publisher.publishIndexingUpdate({ repository: 'integry/propr', phase: 'completed' })],
    [REDIS_CHANNELS.LIVE_DETAILS, publisher => publisher.publishTaskLiveUpdate({
        taskId: 'task-1', events: [], todos: [], currentTask: null, tokenUsage: null,
    })],
    [REDIS_CHANNELS.QUEUE_STATS, publisher => publisher.publishQueueStatsUpdate({
        stats: { waiting: 0, active: 0, completed: 1, failed: 0, delayed: 0, total: 1 },
    })],
];

/** A real TCP/RESP peer with controllable acknowledgements and socket loss. */
async function deliveryRedis(t: TestContext) {
    const sockets = new Set<Socket>();
    const frames: Array<{ channel: string; payload: { state?: string } }> = [];
    const paused = new Set<string>();
    const replies: Array<() => void> = [];
    const commands: string[] = [];
    let silent = false;
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            // ioredis sends arrays of bulk strings; keep incomplete frames for
            // the next TCP chunk and answer each pipelined command separately.
            while (buffer.length) {
                const header = buffer.indexOf('\r\n');
                if (header < 0) return;
                const count = Number(buffer.subarray(1, header).toString());
                let offset = header + 2;
                const args: string[] = [];
                for (let i = 0; i < count; i += 1) {
                    const end = buffer.indexOf('\r\n', offset);
                    if (end < 0) return;
                    const length = Number(buffer.subarray(offset + 1, end).toString());
                    if (buffer.length < end + 2 + length + 2) return;
                    args.push(buffer.subarray(end + 2, end + 2 + length).toString());
                    offset = end + 2 + length + 2;
                }
                buffer = buffer.subarray(offset);
                const command = args[0].toLowerCase();
                commands.push(command);
                const publish = command === 'publish';
                if (publish) frames.push({ channel: args[1], payload: JSON.parse(args[2]) });
                // A silenced peer keeps the socket open but answers nothing.
                if (silent) continue;
                const reply = () => { if (!socket.destroyed) socket.write(publish ? ':1\r\n' : '+OK\r\n'); };
                if (publish && paused.has(args[1])) replies.push(reply);
                else reply();
            }
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.REDIS_PORT = String(address.port);
    const closed = new Promise<void>(resolve => server.once('close', () => resolve()));
    const goAway = async () => {
        server.close();
        for (const socket of sockets) socket.destroy();
        await closed;
    };
    t.after(async () => {
        for (const reply of replies.splice(0)) reply();
        await closeEventPublisher();
        await goAway();
    });
    return { sockets, frames, commands, paused, goAway, silence: () => { silent = true; }, resume: () => {
        paused.clear();
        for (const reply of replies.splice(0)) reply();
    } };
}

describe('existing event stream delivery', { concurrency: false, timeout: 10_000 }, () => {
    test('all existing channels survive a brief reconnect, including terminal task updates', async t => {
        const peer = await deliveryRedis(t);
        let client!: Redis;
        const statuses: string[] = [];
        const publish = Redis.prototype.publish;
        t.mock.method(Redis.prototype, 'publish', function (this: Redis, ...args: Parameters<typeof publish>) {
            client = this;
            statuses.push(this.status);
            return publish.apply(this, args);
        });
        const publisher = getEventPublisher();
        assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-1', state: 'processing' }), true);
        const reconnecting = once(client, 'reconnecting');
        for (const socket of peer.sockets) socket.destroy();
        await reconnecting;
        const results = await Promise.all(lifecyclePublishes.map(([, send]) => send(publisher)));
        assert.equal(results[0], true, 'the terminal task publish is acknowledged after reconnect');
        assert.equal(results[1], true, 'the draft publish is acknowledged after reconnect');
        assert.deepEqual(statuses.slice(1), lifecyclePublishes.map(() => 'reconnecting'));
        assert.deepEqual(peer.frames.slice(1).map(frame => frame.channel), lifecyclePublishes.map(([channel]) => channel));
        assert.equal(peer.frames[1].payload.state, 'completed');
        assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-2', state: 'failed' }), true);
        assert.equal(peer.frames.at(-1)?.payload.state, 'failed');
    });

    test('shutdown does not wait on a lifecycle publish queued while Redis is gone', async t => {
        // Lifecycle streams keep their offline queue and retry forever, so a
        // `quit` sent while reconnecting lines up behind the queued publish and
        // is never answered. A suite's `after` hook that closes the publisher
        // must still return instead of holding its process open.
        const peer = await deliveryRedis(t);
        let client!: Redis;
        const publish = Redis.prototype.publish;
        t.mock.method(Redis.prototype, 'publish', function (this: Redis, ...args: Parameters<typeof publish>) {
            client = this;
            return publish.apply(this, args);
        });
        const publisher = getEventPublisher();
        assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-1', state: 'processing' }), true);
        const reconnecting = once(client, 'reconnecting');
        await peer.goAway();
        await reconnecting;
        const pending = publisher.publishTaskUpdate({ taskId: 'task-1', state: 'completed' });
        // Let the publish reach the client's offline queue before shutting down.
        await delay(20);

        const duration = await elapsedMs(closeEventPublisher);

        assert.ok(duration < 5_000, `closing the publisher took ${duration}ms`);
        assert.equal(await pending, false, 'the queued publish is released by shutdown');
    });

    test('shutdown gives up on a connected Redis that stops answering lifecycle commands', async t => {
        // A `quit` sent on a ready connection is answered after every earlier
        // command. When Redis keeps the socket open but stops answering, the
        // lifecycle publish never settles and neither would `quit`, so shutdown
        // has to reach its own deadline and release the publish itself.
        const peer = await deliveryRedis(t);
        const publisher = getEventPublisher();
        assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-1', state: 'processing' }), true);
        peer.silence();
        const pending = publisher.publishTaskUpdate({ taskId: 'task-1', state: 'completed' });
        // Let the publish reach Redis so it is waiting on an answer, not queued.
        await delay(20);
        assert.equal(peer.frames.at(-1)?.payload.state, 'completed', 'Redis received the publish');
        assert.ok(peer.sockets.size > 0, 'the connection is still open');

        const duration = await elapsedMs(closeEventPublisher);

        assert.ok(peer.commands.includes('quit'), 'shutdown asked the ready connection to quit');
        assert.ok(duration >= 950, `shutdown returned after ${duration}ms, before the quit deadline`);
        assert.ok(duration < 5_000, `closing the publisher took ${duration}ms`);
        assert.equal(await pending, false, 'the unanswered publish is released by shutdown');
    });

    test('a failed initial lifecycle connection does not suppress the next task event', async t => {
        const peer = await deliveryRedis(t);
        t.mock.method(Redis.prototype, 'connect', async () => {
            throw new Error('Transient connection failure');
        }, { times: 1 });
        const publisher = getEventPublisher();
        assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-1', state: 'processing' }), false);
        assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-1', state: 'completed' }), true);
        assert.deepEqual(peer.frames.map(frame => frame.payload.state), ['completed']);
    });

    test('slow existing publishes wait for acknowledgement beyond the best-effort deadline', async t => {
        const peer = await deliveryRedis(t);
        for (const [channel] of lifecyclePublishes) peer.paused.add(channel);
        let settled = 0;
        const pending = Promise.all(lifecyclePublishes.map(async ([, send]) => {
            const result = await send(getEventPublisher());
            settled += 1;
            return result;
        }));
        try {
            await delay(1_200);
            assert.equal(peer.frames.length, lifecyclePublishes.length, 'Redis received all five events');
            assert.equal(settled, 0, 'no delivery result is reported before Redis acknowledges it');
        } finally {
            peer.resume();
        }
        const results = await pending;
        assert.equal(results[0], true);
        assert.equal(results[1], true);
    });

    test('a notification timeout and cooldown cannot drop any existing stream', async t => {
        const peer = await deliveryRedis(t);
        peer.paused.add(REDIS_CHANNELS.NOTIFICATIONS);
        const publisher = getEventPublisher();
        assert.equal(await publisher.publishNotificationUpdate({ change: 'dismissed', recipientId: 'user-a' }), false);
        const results = await Promise.all(lifecyclePublishes.map(([, send]) => send(publisher)));
        assert.equal(results[0], true);
        assert.equal(results[1], true);
        assert.deepEqual(peer.frames.slice(1).map(frame => frame.channel), lifecyclePublishes.map(([channel]) => channel));
        assert.equal(await publisher.publishUsageUpdate(), false, 'new triggers still share the bounded policy');
        assert.equal(await publisher.publishGoalUpdate({ goalId: 'goal-1' }), false);
        assert.equal(await publisher.publishActivity({
            domain: 'task', change: 'completed', entityId: 'task-1', repository: 'integry/propr',
        }), false);
        assert.equal(peer.frames.length, 1 + lifecyclePublishes.length);
        peer.resume();
    });
});

/**
 * Run a fixture to completion in its own process.
 *
 * The fixture is spawned rather than imported because the thing under test is
 * process exit itself, which cannot be observed from inside the process that
 * has to exit.
 */
async function runFixture(
    name: string,
    timeoutMs: number
): Promise<{ code: number | null; reason: string; output: string }> {
    // Node with tsx's loader rather than the `tsx` bin: that wrapper spawns the
    // real process as a child of its own, which would survive the kill below
    // and leave the very hang under test running after the run finished.
    const loader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, join(HERE, 'fixtures', name)], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The parent supplies no Redis: the fixture starts its own stub and
        // points the publisher at it.
        env: { ...process.env, REDIS_HOST: undefined, REDIS_PORT: undefined }
    });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
        return await new Promise(resolve => {
            child.on('error', error => {
                resolve({ code: null, reason: `could not spawn: ${error.message}`, output });
            });
            child.on('close', (code, signal) => {
                resolve({
                    code,
                    // A kill by our own timer is the hang this test exists for.
                    reason: signal ? `killed with ${signal} after ${timeoutMs}ms` : `exit code ${code}`,
                    output
                });
            });
        });
    } finally {
        clearTimeout(timer);
    }
}
