import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Redis from 'ioredis';
import { createDefaultState } from '../src/jobs/ultrafixOrchestrationService.js';
import {
    authorizeUltrafixContinuation,
    recordUltrafixActionWithLease,
} from '../src/jobs/ultrafixLeaseTransitions.js';

test('fenced Ultrafix state transitions preserve the existing state TTL', { timeout: 5000 }, async t => {
    const redis = new Redis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        retryStrategy: () => null,
        lazyConnect: true,
    });
    redis.on('error', () => {});
    try {
        await redis.connect();
    } catch {
        redis.disconnect();
        t.skip('Redis is not available for the integration assertion');
        return;
    }

    const prefix = `test:ultrafix-lease:${randomUUID()}`;
    const stateKey = `${prefix}:state`;
    const lockKey = `${prefix}:lock`;
    const lockToken = 'owned-attempt';
    const lease = { lockKey, lockToken, assertLease: async () => {} };

    try {
        await redis.set(lockKey, lockToken, 'PX', 60_000);
        await redis.set(
            stateKey,
            JSON.stringify(createDefaultState({ owner: 'integry', repo: 'propr', pr: 1748 })),
            'PX',
            60_000,
        );

        const beforeAction = await redis.pttl(stateKey);
        await recordUltrafixActionWithLease(redis, {
            stateKey,
            action: 'review',
            continuationId: 'task-1748',
        }, lease);
        const afterAction = await redis.pttl(stateKey);

        assert.ok(beforeAction > 0);
        assert.ok(afterAction > 0 && afterAction <= beforeAction);

        const beforeAuthorization = await redis.pttl(stateKey);
        await authorizeUltrafixContinuation(redis, {
            stateKey,
            continuationId: 'task-1748:fix',
        }, lease);
        const afterAuthorization = await redis.pttl(stateKey);

        assert.ok(beforeAuthorization > 0);
        assert.ok(afterAuthorization > 0 && afterAuthorization <= beforeAuthorization);
    } finally {
        await redis.del(stateKey, lockKey);
        await redis.quit();
    }
});
