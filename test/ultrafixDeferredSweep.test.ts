import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    scheduleUltrafixDeferredSweep,
    sweepDeferredUltrafixContinuations,
} from '../src/daemon/ultrafixDeferredSweep.js';

test('daemon sweep retries deferred continuations periodically without check events', async () => {
    const resumed: number[] = [];
    const info = mock.fn();
    const deps = {
        listKeys: mock.fn(async () => ['invalid', 'ultrafix:deferred:integry:propr:1806']),
        parseKey: (key: string) => key === 'invalid'
            ? null
            : { owner: 'integry', repo: 'propr', pr: 1806 },
        resume: mock.fn(async (identity: { pr: number }) => {
            resumed.push(identity.pr);
            return { continued: true, reason: 'ready' };
        }),
        createLogger: () => ({ info }) as never,
        warn: mock.fn(),
    };

    const interval = await scheduleUltrafixDeferredSweep({} as never, deps as never, 10);
    try {
        assert.deepEqual(resumed, [1806]);
        await new Promise(resolve => setTimeout(resolve, 35));
        assert.ok(resumed.length >= 2, 'expected a periodic retry after the startup sweep');
        assert.ok(info.mock.callCount() >= 2);
    } finally {
        clearInterval(interval);
    }
});

test('one failed deferred recovery does not starve later PRs', async () => {
    const attempted: number[] = [];
    const warn = mock.fn();
    const info = mock.fn();
    await sweepDeferredUltrafixContinuations({} as never, {
        listKeys: mock.fn(async () => ['deferred:1', 'deferred:2']),
        parseKey: key => ({ owner: 'integry', repo: 'propr', pr: Number(key.split(':')[1]) }),
        resume: mock.fn(async identity => {
            attempted.push(identity.pr);
            if (identity.pr === 1) throw new Error('malformed first continuation');
            return { continued: true, reason: 'resumed' };
        }),
        createLogger: () => ({ info }) as never,
        warn,
    });

    assert.deepEqual(attempted, [1, 2]);
    assert.equal(info.mock.callCount(), 1);
    assert.equal(warn.mock.callCount(), 1);
});
