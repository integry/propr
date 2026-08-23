import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import {
    buildTaskStateMutation,
    buildTaskStateTransition,
    compareAndSetTaskStateData,
} from '../packages/core/src/utils/workerStateTransition.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    TaskStates,
    type TaskStateData,
} from '../packages/core/src/utils/workerStateManager.types.js';

after(closeConnection);

test('Redis CAS rejects a stale metadata snapshot after terminalization', async t => {
    const redis = new Redis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
        connectTimeout: 250,
        enableReadyCheck: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
    });
    redis.on('error', () => {});
    try {
        await redis.connect();
    } catch {
        redis.disconnect();
        t.skip('Redis is not available for integration testing');
        return;
    }

    const key = `test:worker-state-cas:${process.pid}:${Date.now()}`;
    const initial = {
        taskId: 'task-real-redis-cas',
        issueRef: { number: 1753, repoOwner: 'integry', repoName: 'propr' },
        correlationId: 'correlation-real-redis-cas',
        state: TaskStates.PROCESSING,
        createdAt: '2026-08-05T10:00:00.000Z',
        updatedAt: '2026-08-05T10:01:00.000Z',
        version: 1,
        attempts: 0,
        history: [{
            state: TaskStates.PROCESSING,
            timestamp: '2026-08-05T10:01:00.000Z',
            reason: 'Processing',
        }],
    } satisfies TaskStateData;
    const initialJson = JSON.stringify(initial);

    try {
        await redis.setex(key, 60, initialJson);
        const terminal = buildTaskStateTransition(initial, TaskStates.COMPLETED, {
            reason: 'BullMQ completed',
        }).state;
        const staleMetadata = buildTaskStateMutation(initial, state => {
            state.issueRef = { ...state.issueRef, modelName: 'gpt-5.6' };
        });

        assert.equal(await compareAndSetTaskStateData(redis, {
            key,
            stateExpiry: 60,
            currentJson: initialJson,
            state: terminal,
        }), true);
        assert.equal(await compareAndSetTaskStateData(redis, {
            key,
            stateExpiry: 60,
            currentJson: initialJson,
            state: staleMetadata,
        }), false);

        const storedAfterConflict = await redis.get(key);
        assert.ok(storedAfterConflict);
        assert.equal((JSON.parse(storedAfterConflict) as TaskStateData).state, TaskStates.COMPLETED);

        const freshTerminalPatch = buildTaskStateMutation(terminal, state => {
            state.issueRef = { ...state.issueRef, modelName: 'gpt-5.6' };
        });
        assert.equal(await compareAndSetTaskStateData(redis, {
            key,
            stateExpiry: 60,
            currentJson: JSON.stringify(terminal),
            state: freshTerminalPatch,
        }), true);

        const storedAfterRetry = JSON.parse(await redis.get(key) ?? '') as TaskStateData;
        assert.equal(storedAfterRetry.state, TaskStates.COMPLETED);
        assert.equal(storedAfterRetry.issueRef.modelName, 'gpt-5.6');
        assert.equal(storedAfterRetry.version, 3);
    } finally {
        await redis.del(key).catch(() => 0);
        redis.disconnect();
    }
});
