import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    getManualTakeoverIntentKey,
    getManualTakeoverStageKey,
    sweepManualUltrafixTakeovers,
    type ManualTakeoverStageIdentity,
} from '../src/daemon/ultrafixTakeoverSweep.js';
import { getPendingPrCommentsKey } from '../packages/core/src/utils/constants.js';

function createRedis(identity: ManualTakeoverStageIdentity, sequence: number, intent?: Record<string, unknown>) {
    const stageKey = getManualTakeoverStageKey(identity);
    const strings = new Map([[stageKey, String(sequence)]]);
    if (intent) strings.set(getManualTakeoverIntentKey(identity), JSON.stringify(intent));
    const lists = new Map<string, string[]>();
    return {
        stageKey,
        strings,
        lists,
        redis: {
            scan: mock.fn(async () => ['0', [...strings.keys()]]),
            get: mock.fn(async (key: string) => strings.get(key) ?? null),
            lrange: mock.fn(async (key: string) => lists.get(key) ?? []),
            eval: mock.fn(async (_script: string, _count: number, key: string, intentKey: string, expected: string) => {
                if (strings.get(key) !== expected) return 0;
                strings.delete(key);
                strings.delete(intentKey);
                return 1;
            }),
        },
    };
}

function createDeps(getJob: (jobId: string) => Promise<unknown | null>) {
    const complete = mock.fn(async () => 4 as number | null);
    const ensureFence = mock.fn(async () => true);
    const enqueueReplacement = mock.fn(async () => {});
    const info = mock.fn();
    return {
        complete,
        ensureFence,
        enqueueReplacement,
        info,
        deps: {
            getJob,
            enqueueReplacement,
            complete,
            ensureFence,
            withLease: mock.fn(async (
                _redis: unknown,
                _identity: unknown,
                _correlationId: string,
                operation: (assertOwned: () => Promise<void>) => Promise<unknown>,
            ) => operation(async () => {})),
            createLogger: () => ({ info }),
            generateCorrelationId: () => 'takeover-recovery-correlation',
            warn: mock.fn(),
        },
    };
}

const identity: ManualTakeoverStageIdentity = {
    owner: 'integry', repo: 'propr', pr: 1806, eventType: 'issue_comment', commentId: 900,
};

test('daemon recovery commits a staged takeover only after its deterministic job is durable', async () => {
    const { redis, strings, stageKey } = createRedis(identity, 12);
    const seenJobIds: string[] = [];
    const { deps, complete } = createDeps(async jobId => {
        seenJobIds.push(jobId);
        return {};
    });

    await sweepManualUltrafixTakeovers(redis as never, deps as never);

    assert.equal(complete.mock.callCount(), 1);
    assert.equal(strings.has(stageKey), false);
    assert.ok(seenJobIds.every(jobId => jobId.endsWith('-900-12')));
});

test('daemon recovery leaves a pre-scheduling marker fenced until durable evidence appears', async () => {
    const { redis, strings, stageKey } = createRedis(identity, 13);
    const { deps, complete } = createDeps(async () => null);

    await sweepManualUltrafixTakeovers(redis as never, deps as never);

    assert.equal(complete.mock.callCount(), 0);
    assert.equal(strings.get(stageKey), '13');
});

test('daemon recovery accepts an atomically staged pending batch as durable evidence', async () => {
    const { redis, lists, strings, stageKey } = createRedis(identity, 14);
    lists.set(getPendingPrCommentsKey(identity.owner, identity.repo, identity.pr), [
        JSON.stringify({ id: identity.commentId, commandSequence: 14 }),
    ]);
    const { deps, complete } = createDeps(async () => null);

    await sweepManualUltrafixTakeovers(redis as never, deps as never);

    assert.equal(complete.mock.callCount(), 1);
    assert.equal(strings.has(stageKey), false);
});

test('daemon recovery enqueues a missing replacement from the durable takeover intent', async () => {
    const pendingComment = {
        id: identity.commentId,
        body: 'F31',
        author: 'integry',
        type: 'issue',
        commandMode: 'fix',
        commandSequence: 15,
    };
    const { redis, strings, stageKey } = createRedis(identity, 15, pendingComment);
    let queued = false;
    const { deps, complete, enqueueReplacement } = createDeps(async () => queued ? {} : null);
    enqueueReplacement.mock.mockImplementationOnce(async () => { queued = true; });

    await sweepManualUltrafixTakeovers(redis as never, deps as never);

    assert.equal(enqueueReplacement.mock.callCount(), 1);
    assert.deepEqual(enqueueReplacement.mock.calls[0].arguments[1], identity);
    assert.deepEqual(enqueueReplacement.mock.calls[0].arguments[2], pendingComment);
    assert.equal(complete.mock.callCount(), 1);
    assert.equal(strings.has(stageKey), false);
    assert.equal(strings.has(getManualTakeoverIntentKey(identity)), false);
});

test('daemon recovery re-establishes a missing fence before deleting the stage', async () => {
    const { redis, strings, stageKey } = createRedis(identity, 16);
    const { deps, complete, ensureFence } = createDeps(async () => ({}));
    complete.mock.mockImplementationOnce(async () => null);

    await sweepManualUltrafixTakeovers(redis as never, deps as never);

    assert.equal(ensureFence.mock.callCount(), 1);
    assert.equal(complete.mock.callCount(), 2);
    assert.equal(strings.has(stageKey), false);
});

test('daemon recovery removes a stage only after a newer sequence is proven', async () => {
    const { redis, strings, stageKey } = createRedis(identity, 17);
    const { deps, complete, ensureFence } = createDeps(async () => ({}));
    complete.mock.mockImplementationOnce(async () => null);
    ensureFence.mock.mockImplementationOnce(async () => false);

    await sweepManualUltrafixTakeovers(redis as never, deps as never);

    assert.equal(complete.mock.callCount(), 1);
    assert.equal(ensureFence.mock.callCount(), 1);
    assert.equal(strings.has(stageKey), false);
});

test('one failed takeover recovery does not starve later PRs', async () => {
    const secondIdentity = { ...identity, pr: 1807, commentId: 901 };
    const firstKey = getManualTakeoverStageKey(identity);
    const secondKey = getManualTakeoverStageKey(secondIdentity);
    const strings = new Map([[firstKey, '18'], [secondKey, '19']]);
    const redis = {
        scan: mock.fn(async () => ['0', [firstKey, secondKey]]),
        get: mock.fn(async (key: string) => strings.get(key) ?? null),
        lrange: mock.fn(async () => []),
        eval: mock.fn(async (_script: string, _count: number, key: string) => {
            strings.delete(key);
            return 1;
        }),
    };
    const attempted: number[] = [];
    const { deps } = createDeps(async jobId => {
        const pr = jobId.includes('-1806-') ? 1806 : 1807;
        attempted.push(pr);
        if (pr === 1806) throw new Error('broken first recovery');
        return {};
    });

    await sweepManualUltrafixTakeovers(redis as never, deps as never);

    assert.equal(attempted[0], 1806);
    assert.ok(attempted.slice(1).every(pr => pr === 1807));
    assert.equal(deps.warn.mock.callCount(), 1);
    assert.equal(strings.has(secondKey), false);
});
