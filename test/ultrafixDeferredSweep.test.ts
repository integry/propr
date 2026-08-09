import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleUltrafixDeferredSweep } from '../src/daemon/ultrafixDeferredSweep.js';

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
