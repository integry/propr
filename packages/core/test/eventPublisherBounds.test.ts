import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeEventPublisher, getEventPublisher } from '../src/utils/eventPublisher.js';
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
