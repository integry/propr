import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Redis from 'ioredis';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { closeEventPublisher } from '../packages/core/src/utils/eventPublisher.js';
import { TaskStates, WorkerStateManager } from '../packages/core/src/utils/workerStateManager.js';
import type { TaskStateData } from '../packages/core/src/utils/workerStateManager.types.js';

after(async () => {
    await closeEventPublisher();
    await closeConnection();
});

test('real Redis CAS permits only one guarded terminal transition', { timeout: 5000 }, async t => {
    const redisOptions = {
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        retryStrategy: () => null,
    };
    const redis = new Redis({ ...redisOptions, lazyConnect: true });
    redis.on('error', () => {});
    try {
        await redis.connect();
    } catch {
        redis.disconnect();
        t.skip('Redis is not available for the integration assertion');
        return;
    }

    const keyPrefix = `test:worker-state-cas:${randomUUID()}:`;
    const taskId = 'concurrent-finalizers';
    const key = `${keyPrefix}${taskId}`;
    const initial: TaskStateData = {
        taskId,
        issueRef: { number: 1748, repoOwner: 'integry', repoName: 'propr', type: 'pr_comment' },
        correlationId: randomUUID(),
        state: TaskStates.PROCESSING,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:01:00.000Z',
        attempts: 0,
        history: [],
    };
    const manager = new WorkerStateManager({
        keyPrefix,
        stateExpiry: 60,
        redis: redisOptions,
    });

    try {
        await redis.set(key, JSON.stringify(initial), 'EX', 60);
        const results = await Promise.all([
            manager.updateTaskStateIfCurrent(
                taskId,
                { state: initial.state, updatedAt: initial.updatedAt },
                TaskStates.COMPLETED,
                { reason: 'completed event' },
            ),
            manager.updateTaskStateIfCurrent(
                taskId,
                { state: initial.state, updatedAt: initial.updatedAt },
                TaskStates.FAILED,
                { reason: 'reconciler interruption' },
            ),
        ]);

        assert.equal(results.filter(Boolean).length, 1);
        const stored = JSON.parse((await redis.get(key))!) as TaskStateData;
        assert.ok(stored.state === TaskStates.COMPLETED || stored.state === TaskStates.FAILED);
        assert.equal(stored.history.length, 1);
    } finally {
        await redis.del(key);
        await manager.close();
        await redis.quit();
    }
});
