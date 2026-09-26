import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeEventPublisher, getEventPublisher } from '../src/utils/eventPublisher.js';
import { SilentRedis } from './silentRedisStub.js';

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
});
