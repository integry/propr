import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeEventPublisher, getEventPublisher } from '../src/utils/eventPublisher.js';

/**
 * A Redis that accepts connections and then says nothing.
 *
 * This is the outage the publisher has to survive: not a refused connection,
 * which fails fast on its own, but a server that takes the command and never
 * answers. Its callers have already committed their database write by the time
 * they publish, so the wait has to end whether Redis comes back or not.
 */
class SilentRedis {
    private readonly sockets = new Set<Socket>();
    private constructor(private readonly server: Server, readonly port: number) {}

    static async listen(): Promise<SilentRedis> {
        const server = createServer();
        server.unref();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address === 'object', 'the stub must report a port');
        const stub = new SilentRedis(server, address.port);
        server.on('connection', socket => {
            socket.unref();
            stub.sockets.add(socket);
            socket.on('close', () => stub.sockets.delete(socket));
        });
        return stub;
    }

    /** Take the server away, the way a Redis restart or a network cut does. */
    async goAway(): Promise<void> {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}

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

    test('shutdown does not wait on an unreachable Redis either', async () => {
        await publishNotification();
        await stub.goAway();

        const duration = await elapsedMs(closeEventPublisher);

        assert.ok(duration < 5_000, `closing the publisher took ${duration}ms`);
    });
});
