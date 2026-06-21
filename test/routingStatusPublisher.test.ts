import { after, beforeEach, afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { closeConnection, type RoutingWebSocketIntakeService } from '@propr/core';
import { startRoutingStatusPublisher } from '../src/daemon/routingStatusPublisher.js';

// Importing @propr/core eagerly opens the shared DB connection pool; close it so
// the test process can exit cleanly instead of hanging on the open pool.
after(async () => {
    await closeConnection();
});

import { ROUTING_STATUS_REDIS_KEY } from '@propr/shared';

const ROUTING_STATUS_KEY = ROUTING_STATUS_REDIS_KEY;

/** A fake ioredis recording set/del calls, with both resolving immediately. */
function makeFakeRedis() {
    return {
        set: mock.fn(async () => 'OK'),
        del: mock.fn(async () => 1),
    };
}

/**
 * Minimal fake routing service exposing the two surfaces the publisher uses:
 * a snapshot getter and the status-change listener registration.
 */
function makeFakeService(status: Record<string, unknown>) {
    let listener: (() => void) | null = null;
    return {
        getStatus: mock.fn(() => status),
        // Mirror the real service: register the listener and return an unsubscribe
        // that detaches only this listener.
        onStatusChange: mock.fn((cb: () => void) => {
            listener = cb;
            return () => { if (listener === cb) listener = null; };
        }),
        /** Test helper: fire the registered status-change listener. */
        fireStatusChange(): void { listener?.(); },
        /** Test helper: whether a status-change listener is currently attached. */
        hasListener(): boolean { return listener !== null; },
    };
}

beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
});

afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
});

test('publishes the routing status with a TTL on startup', async () => {
    const redis = makeFakeRedis();
    const service = makeFakeService({ connected: true, lastDeliveryId: 'd1' });

    await startRoutingStatusPublisher(
        service as unknown as RoutingWebSocketIntakeService,
        redis as never,
    );

    // Exactly one publish on startup, writing the serialized snapshot under the
    // shared status key with an expiry (EX) so the key self-heals on a hard crash.
    assert.equal(redis.set.mock.calls.length, 1);
    const [key, value, exFlag, ttl] = redis.set.mock.calls[0].arguments as [string, string, string, number];
    assert.equal(key, ROUTING_STATUS_KEY);
    assert.deepEqual(JSON.parse(value), { connected: true, lastDeliveryId: 'd1' });
    assert.equal(exFlag, 'EX');
    assert.ok(typeof ttl === 'number' && ttl > 0);
});

test('re-publishes on the periodic refresh interval', async () => {
    const redis = makeFakeRedis();
    const service = makeFakeService({ connected: true });

    await startRoutingStatusPublisher(
        service as unknown as RoutingWebSocketIntakeService,
        redis as never,
    );
    assert.equal(redis.set.mock.calls.length, 1); // startup publish

    // Advancing past the 30s refresh cadence triggers another publish.
    mock.timers.tick(30000);
    assert.equal(redis.set.mock.calls.length, 2);
});

test('publishes promptly (debounced) when the routing status changes', async () => {
    const redis = makeFakeRedis();
    const service = makeFakeService({ connected: false });

    await startRoutingStatusPublisher(
        service as unknown as RoutingWebSocketIntakeService,
        redis as never,
    );
    assert.equal(redis.set.mock.calls.length, 1); // startup publish

    // A burst of status changes (e.g. connect + several ACKs) coalesces into a
    // single Redis write once the short debounce window elapses.
    service.fireStatusChange();
    service.fireStatusChange();
    service.fireStatusChange();
    assert.equal(redis.set.mock.calls.length, 1); // not yet — still debouncing

    mock.timers.tick(250);
    assert.equal(redis.set.mock.calls.length, 2); // one coalesced publish
});

test('stop() clears the published status and stops publishing', async () => {
    const redis = makeFakeRedis();
    const service = makeFakeService({ connected: true });

    const publisher = await startRoutingStatusPublisher(
        service as unknown as RoutingWebSocketIntakeService,
        redis as never,
    );
    const publishesBeforeStop = redis.set.mock.calls.length;

    await publisher.stop();

    // The key is deleted so status consumers immediately see the routing path down.
    assert.equal(redis.del.mock.calls.length, 1);
    assert.equal(redis.del.mock.calls[0].arguments[0], ROUTING_STATUS_KEY);

    // No further publishes after stop: the periodic interval and any pending
    // change-triggered publish are cancelled.
    mock.timers.tick(60000);
    service.fireStatusChange();
    mock.timers.tick(250);
    assert.equal(redis.set.mock.calls.length, publishesBeforeStop);
});

test('stop() unsubscribes the status-change listener from the service', async () => {
    const redis = makeFakeRedis();
    const service = makeFakeService({ connected: true });

    const publisher = await startRoutingStatusPublisher(
        service as unknown as RoutingWebSocketIntakeService,
        redis as never,
    );
    assert.equal(service.hasListener(), true);

    await publisher.stop();

    // The publisher detaches its listener so the service no longer retains the
    // publisher's closure (which would leak if the service were restarted).
    assert.equal(service.hasListener(), false);
});
