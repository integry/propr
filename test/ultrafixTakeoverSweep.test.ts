import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    getManualTakeoverStageKey,
    sweepManualUltrafixTakeovers,
    type ManualTakeoverStageIdentity,
} from '../src/daemon/ultrafixTakeoverSweep.js';
import { getPendingPrCommentsKey } from '../packages/core/src/utils/constants.js';

function createRedis(identity: ManualTakeoverStageIdentity, sequence: number) {
    const stageKey = getManualTakeoverStageKey(identity);
    const strings = new Map([[stageKey, String(sequence)]]);
    const lists = new Map<string, string[]>();
    return {
        stageKey,
        strings,
        lists,
        redis: {
            scan: mock.fn(async () => ['0', [...strings.keys()]]),
            get: mock.fn(async (key: string) => strings.get(key) ?? null),
            lrange: mock.fn(async (key: string) => lists.get(key) ?? []),
            eval: mock.fn(async (_script: string, _count: number, key: string, expected: string) => {
                if (strings.get(key) !== expected) return 0;
                strings.delete(key);
                return 1;
            }),
        },
    };
}

function createDeps(getJob: (jobId: string) => Promise<unknown | null>) {
    const complete = mock.fn(async () => 4 as number | null);
    const info = mock.fn();
    return {
        complete,
        info,
        deps: {
            getJob,
            complete,
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
