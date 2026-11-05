/**
 * Publishes one event against a healthy Redis and then simply ends.
 *
 * This stands in for every test suite that reaches a publishing code path
 * without knowing it did: it never calls `closeEventPublisher()`. The process
 * must still exit on its own. Spawned by `eventPublisherBounds.test.ts`, which
 * asserts exactly that - a hang here is the failure under test, so this file
 * deliberately has no timeout or forced exit of its own.
 */
import assert from 'node:assert/strict';
import { AnsweringRedis } from '../answeringRedisStub.js';
import { getEventPublisher } from '../../src/utils/eventPublisher.js';

const stub = await AnsweringRedis.listen();
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = String(stub.port);

const published = await getEventPublisher().publishNotificationUpdate({
    change: 'dismissed',
    eventId: 'event-1',
    recipientIds: ['user-a'],
    repository: 'integry/propr',
    occurredAt: new Date().toISOString()
});

// If the publish were dropped the process would exit for the wrong reason:
// there would be no live connection to hold it open in the first place.
assert.ok(published, 'the fixture must actually reach the stub Redis');
