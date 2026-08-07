import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import {
    acquirePRProcessingLock,
    assertPRProcessingLock,
    DEFAULT_PR_PROCESSING_LOCK_TTL_SECONDS,
    MAXIMUM_PR_PROCESSING_LOCK_TTL_SECONDS,
    MINIMUM_PR_PROCESSING_LOCK_TTL_SECONDS,
    PR_PROCESSING_LOCK_TTL_SECONDS,
    PRProcessingLeaseLostError,
    startPRProcessingLockHeartbeat,
} from '../src/jobs/prProcessingLock.js';
import { readBoundedIntegerEnv } from '../src/config/numericEnv.js';

describe('PR processing lock lease', () => {
    test('uses a short renewable lease by default', async () => {
        assert.equal(DEFAULT_PR_PROCESSING_LOCK_TTL_SECONDS, 120);
        assert.equal(MINIMUM_PR_PROCESSING_LOCK_TTL_SECONDS, 90);
        assert.equal(MAXIMUM_PR_PROCESSING_LOCK_TTL_SECONDS, 86_400);
        assert.ok(PR_PROCESSING_LOCK_TTL_SECONDS >= MINIMUM_PR_PROCESSING_LOCK_TTL_SECONDS);

        const set = mock.fn(async () => 'OK');
        const acquired = await acquirePRProcessingLock({ set } as never, 'lock:key', 'owner-token');

        assert.equal(acquired, true);
        assert.deepEqual(set.mock.calls[0].arguments, [
            'lock:key',
            'owner-token',
            'EX',
            PR_PROCESSING_LOCK_TTL_SECONDS,
            'NX',
        ]);
    });

    test('rejects unsafe and out-of-range numeric configuration', () => {
        const name = 'PROPR_TEST_BOUNDED_INTEGER';
        const previous = process.env[name];
        try {
            process.env[name] = String(Number.MAX_SAFE_INTEGER + 1);
            assert.equal(readBoundedIntegerEnv(name, { fallback: 120, min: 90, max: 86_400 }), 120);
            process.env[name] = '86401';
            assert.equal(readBoundedIntegerEnv(name, { fallback: 120, min: 90, max: 86_400 }), 120);
            process.env[name] = '3600';
            assert.equal(readBoundedIntegerEnv(name, { fallback: 120, min: 90, max: 86_400 }), 3600);
        } finally {
            if (previous === undefined) delete process.env[name];
            else process.env[name] = previous;
        }
    });

    test('reports heartbeat ownership loss so the protected execution can abort', async () => {
        const onLockLost = mock.fn();
        const stop = startPRProcessingLockHeartbeat({
            redisClient: { eval: mock.fn(async () => 0) } as never,
            lockKey: 'lock:key',
            lockToken: 'expired-token',
            intervalMs: 5,
            onLockLost,
        });

        await new Promise(resolve => setTimeout(resolve, 20));
        await stop();
        assert.ok(onLockLost.mock.calls.length >= 1);
    });

    test('throws a dedicated error when an ownership assertion no longer matches', async () => {
        await assert.rejects(
            assertPRProcessingLock(
                { eval: mock.fn(async () => 0) } as never,
                'lock:key',
                'stale-token',
            ),
            PRProcessingLeaseLostError,
        );
    });
});
