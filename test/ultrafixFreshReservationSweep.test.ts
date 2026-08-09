import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    getUltrafixFreshReservationKey,
    getUltrafixTakeoverFenceKey,
} from '../src/jobs/ultrafixDeferredContinuationStore.js';
import { sweepFreshUltrafixReservations } from '../src/daemon/ultrafixFreshReservationSweep.js';

const identity = { owner: 'integry', repo: 'propr', pr: 1806 };
const reservationKey = getUltrafixFreshReservationKey(identity.owner, identity.repo, identity.pr);
const fenceKey = getUltrafixTakeoverFenceKey(identity.owner, identity.repo, identity.pr);

function createRedis(createdAt: number) {
    const strings = new Map<string, string>([
        [reservationKey, `12:8:7:${createdAt}:startup-job-8`],
        [fenceKey, '12'],
    ]);
    return {
        strings,
        redis: {
            scan: mock.fn(async () => ['0', [reservationKey]]),
            get: mock.fn(async (key: string) => strings.get(key) ?? null),
            eval: mock.fn(async (
                _script: string,
                _keyCount: number,
                suppliedFenceKey: string,
                suppliedReservationKey: string,
                expectedSequence: string,
            ) => {
                if (strings.get(suppliedFenceKey) !== expectedSequence) return 0;
                strings.delete(suppliedFenceKey);
                strings.delete(suppliedReservationKey);
                return 1;
            }),
        },
    };
}

function createDeps(getJob: (jobId: string) => Promise<unknown | null>, now: number) {
    const warnLog = mock.fn();
    return {
        warnLog,
        deps: {
            getJob,
            withLease: mock.fn(async (
                _redis: unknown,
                _identity: unknown,
                _correlationId: string,
                operation: (assertOwned: () => Promise<void>) => Promise<unknown>,
            ) => operation(async () => {})),
            createLogger: () => ({ warn: warnLog }),
            generateCorrelationId: () => 'fresh-reservation-sweep',
            warn: mock.fn(),
            now: () => now,
            orphanGraceMs: 300_000,
        },
    };
}

test('fresh reservation sweep aborts an aged reservation with no durable startup job', async () => {
    const now = 1_000_000;
    const { redis, strings } = createRedis(now - 300_001);
    const { deps, warnLog } = createDeps(async () => null, now);

    await sweepFreshUltrafixReservations(redis as never, deps as never);

    assert.equal(strings.has(reservationKey), false);
    assert.equal(strings.has(fenceKey), false);
    assert.equal(warnLog.mock.callCount(), 1);
});

test('fresh reservation sweep preserves an aged reservation once its startup job is durable', async () => {
    const now = 1_000_000;
    const { redis, strings } = createRedis(now - 300_001);
    const { deps } = createDeps(async () => ({}), now);

    await sweepFreshUltrafixReservations(redis as never, deps as never);

    assert.equal(strings.has(reservationKey), true);
    assert.equal(strings.has(fenceKey), true);
});

test('fresh reservation sweep preserves a job-less reservation during its startup grace period', async () => {
    const now = 1_000_000;
    const { redis, strings } = createRedis(now - 299_999);
    const { deps } = createDeps(async () => null, now);

    await sweepFreshUltrafixReservations(redis as never, deps as never);

    assert.equal(strings.has(reservationKey), true);
    assert.equal(strings.has(fenceKey), true);
});

test('fresh reservation sweep does not abort when the startup job appears before lease commit', async () => {
    const now = 1_000_000;
    const { redis, strings } = createRedis(now - 300_001);
    let lookups = 0;
    const { deps } = createDeps(async () => ++lookups > 1 ? {} : null, now);

    await sweepFreshUltrafixReservations(redis as never, deps as never);

    assert.equal(strings.has(reservationKey), true);
    assert.equal(strings.has(fenceKey), true);
});
