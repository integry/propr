import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Redis from 'ioredis';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { closeEventPublisher } from '../packages/core/src/utils/eventPublisher.js';
import { TaskStates, WorkerStateManager } from '../packages/core/src/utils/workerStateManager.js';
import {
    COMPARE_AND_SET_TASK_STATE_SCRIPT,
    CREATE_FENCED_TASK_STATE_SCRIPT,
} from '../packages/core/src/utils/workerStatePersistence.js';
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
    const revisionKey = `revision:${keyPrefix}${taskId}`;
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
        await redis.del(key, revisionKey);
        await manager.close();
        await redis.quit();
    }
});

test('fenced task revisions remain monotonic after the expiring state is recreated', { timeout: 5000 }, async t => {
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

    const prefix = `test:worker-state-revision:${randomUUID()}`;
    const stateKey = `${prefix}:state`;
    const revisionKey = `${prefix}:revision`;
    const lockKey = `${prefix}:lock`;
    const lockToken = 'owned-attempt';
    const initial = {
        taskId: 'recreated-task',
        issueRef: { number: 1748, repoOwner: 'integry', repoName: 'propr' },
        correlationId: randomUUID(),
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        attempts: 0,
        history: [],
        prProcessingLockToken: lockToken,
    };

    try {
        await redis.set(lockKey, lockToken, 'EX', 60);
        const firstVersion = await redis.eval(
            CREATE_FENCED_TASK_STATE_SCRIPT,
            3,
            stateKey,
            lockKey,
            revisionKey,
            lockToken,
            60,
            120,
            JSON.stringify(initial),
        );

        let highestVersion = Number(firstVersion);
        for (const mutate of [
            (state: TaskStateData) => {
                state.state = TaskStates.PROCESSING;
                state.history.push({ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'processing' });
            },
            (state: TaskStateData) => {
                state.issueRef.title = 'Recovered title';
            },
            (state: TaskStateData) => {
                state.history.at(-1)!.metadata = { containerId: 'container-1' };
            },
        ]) {
            const currentJson = (await redis.get(stateKey))!;
            const next = JSON.parse(currentJson) as TaskStateData;
            mutate(next);
            next.version = (next.version ?? 0) + 1;
            next.updatedAt = new Date().toISOString();
            const result = await redis.eval(
                COMPARE_AND_SET_TASK_STATE_SCRIPT,
                2,
                stateKey,
                revisionKey,
                currentJson,
                60,
                120,
                JSON.stringify(next),
            ) as [number, number];
            assert.equal(Number(result[0]), 1);
            highestVersion = Number(result[1]);
        }

        await redis.del(stateKey);
        const recreatedVersion = await redis.eval(
            CREATE_FENCED_TASK_STATE_SCRIPT,
            3,
            stateKey,
            lockKey,
            revisionKey,
            lockToken,
            60,
            120,
            JSON.stringify(initial),
        );

        assert.equal(Number(firstVersion), 1);
        assert.ok(Number(recreatedVersion) > highestVersion);
        const recreated = JSON.parse((await redis.get(stateKey))!) as TaskStateData;
        assert.equal(recreated.version, Number(recreatedVersion));
        const revisionTtl = await redis.ttl(revisionKey);
        assert.ok(revisionTtl > 0 && revisionTtl <= 120);
    } finally {
        await redis.del(stateKey, revisionKey, lockKey);
        await redis.quit();
    }
});
