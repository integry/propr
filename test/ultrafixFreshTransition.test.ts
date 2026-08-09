import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import {
    beginManualUltrafixTakeover,
    completeManualUltrafixTakeover,
    getUltrafixDeferredGenerationKey,
    getUltrafixDeferredKey,
    getUltrafixFreshReservationKey,
    getUltrafixGenerationAllocationKey,
    getUltrafixTakeoverFenceKey,
    getUltrafixTransitionOrderKey,
    isManualUltrafixCommandSequenceCurrent,
} from '../src/jobs/ultrafixDeferredContinuationStore.js';
import {
    abortFreshUltrafixTransition,
    commitFreshUltrafixTransitionState,
    loadFreshUltrafixReservation,
    reserveFreshUltrafixTransition,
} from '../src/jobs/ultrafixFreshTransitionStore.js';
import {
    adoptLegacyUltrafixGeneration,
    getUltrafixStateKey,
    isUltrafixGenerationActive,
} from '../src/jobs/ultrafixLoopStateStore.js';

test('fresh Ultrafix publication preserves its predecessor and never reuses an aborted generation', async t => {
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

    const identity = { owner: `fresh-transition-${process.pid}`, repo: String(Date.now()), pr: 42 };
    const key = (fn: (owner: string, repo: string, pr: number) => string): string => (
        fn(identity.owner, identity.repo, identity.pr)
    );
    const generationKey = key(getUltrafixDeferredGenerationKey);
    const deferredKey = key(getUltrafixDeferredKey);
    const allocationKey = key(getUltrafixGenerationAllocationKey);
    const stateKey = getUltrafixStateKey(identity.owner, identity.repo, identity.pr);
    const manualStageKey = `pr-command-takeover:${identity.owner}:${identity.repo}:${identity.pr}:issue_comment:99`;
    const manualIntentKey = `${manualStageKey}:intent`;
    const keys = [
        generationKey,
        deferredKey,
        allocationKey,
        key(getUltrafixTransitionOrderKey),
        key(getUltrafixTakeoverFenceKey),
        key(getUltrafixFreshReservationKey),
        stateKey,
        manualStageKey,
        manualIntentKey,
    ];

    try {
        await redis.mset(generationKey, '7', allocationKey, '7', deferredKey, 'predecessor', stateKey, 'old-state');
        const first = await reserveFreshUltrafixTransition(redis, identity, 1, 'startup-job-');
        assert.deepEqual(first, { generation: 8, baseGeneration: 7 });
        const reservationTtl = await redis.ttl(key(getUltrafixFreshReservationKey));
        assert.ok(reservationTtl > 0 && reservationTtl <= 86400);
        assert.equal((await loadFreshUltrafixReservation(redis, identity))?.startupJobId, 'startup-job-8');
        assert.equal(await redis.get(generationKey), '7');
        assert.equal(await redis.get(deferredKey), 'predecessor');
        assert.equal(await redis.get(stateKey), 'old-state');

        assert.equal(await abortFreshUltrafixTransition(redis, identity, 1), true);
        const retry = await reserveFreshUltrafixTransition(redis, identity, 1, 'startup-job-');
        assert.deepEqual(retry, { generation: 9, baseGeneration: 7 });
        assert.equal(await commitFreshUltrafixTransitionState(redis, {
            identity,
            commandSequence: 1,
            generation: 9,
            baseGeneration: 7,
            stateKey,
            serializedState: 'new-state',
        }), true);
        assert.equal(await commitFreshUltrafixTransitionState(redis, {
            identity,
            commandSequence: 1,
            generation: 9,
            baseGeneration: 7,
            stateKey,
            serializedState: 'new-state',
        }), true);
        assert.equal(await redis.get(generationKey), '9');
        assert.equal(await redis.get(deferredKey), null);
        assert.equal(await redis.get(stateKey), 'new-state');

        const superseded = await reserveFreshUltrafixTransition(redis, identity, 2, 'startup-job-');
        assert.deepEqual(superseded, { generation: 10, baseGeneration: 9 });
        const serializedManualComment = JSON.stringify({
            id: 99, body: 'F31', author: 'integry', type: 'issue', commandMode: 'fix', commandSequence: 3,
        });
        assert.equal(await beginManualUltrafixTakeover(redis, identity, 3, {
            stageKey: manualStageKey,
            intentKey: manualIntentKey,
            serializedComment: serializedManualComment,
            ttlSeconds: 86400,
        }), true);
        assert.equal(await redis.get(manualStageKey), '3');
        assert.equal(await redis.get(manualIntentKey), serializedManualComment);
        assert.equal(await isManualUltrafixCommandSequenceCurrent(redis, identity, 2), false);
        assert.equal(await isManualUltrafixCommandSequenceCurrent(redis, identity, 3), true);
        assert.equal(await completeManualUltrafixTakeover(redis, identity, 3), 11);
        assert.equal(await isManualUltrafixCommandSequenceCurrent(redis, identity, 2), false);
        assert.equal(await isManualUltrafixCommandSequenceCurrent(redis, identity, 3), true);
        assert.equal(await commitFreshUltrafixTransitionState(redis, {
            identity,
            commandSequence: 2,
            generation: 10,
            baseGeneration: 9,
            stateKey,
            serializedState: 'stale-state',
        }), false);
        assert.equal(await redis.get(generationKey), '11');
        assert.equal(await redis.get(stateKey), 'new-state');
        await redis.set(stateKey, JSON.stringify({ active: true, generation: 11 }));
        assert.equal(await isUltrafixGenerationActive(redis, identity, 11), true);
        await redis.set(stateKey, JSON.stringify({ active: false, generation: 11 }));
        assert.equal(await isUltrafixGenerationActive(redis, identity, 11), false);
        assert.equal(await isUltrafixGenerationActive(redis, identity, 10), false);
    } finally {
        await redis.del(...keys);
        redis.disconnect();
    }
});

test('legacy generation adoption is allowed only before a takeover advances generation', async t => {
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

    const identity = { owner: `legacy-generation-${process.pid}`, repo: String(Date.now()), pr: 43 };
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    const stateKey = getUltrafixStateKey(identity.owner, identity.repo, identity.pr);
    try {
        await redis.set(stateKey, JSON.stringify({ active: true, goal: 8 }));
        assert.equal(await adoptLegacyUltrafixGeneration(redis, identity), true);
        assert.equal(await redis.get(generationKey), '0');
        assert.equal(JSON.parse(await redis.get(stateKey) ?? '{}').generation, 0);

        await redis.set(generationKey, '1');
        await redis.set(stateKey, JSON.stringify({ active: true }));
        assert.equal(await adoptLegacyUltrafixGeneration(redis, identity), false);
        assert.equal(JSON.parse(await redis.get(stateKey) ?? '{}').generation, undefined);
    } finally {
        await redis.del(generationKey, stateKey);
        redis.disconnect();
    }
});
