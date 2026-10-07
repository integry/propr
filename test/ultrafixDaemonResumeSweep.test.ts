/**
 * The daemon runs the same Ultrafix resume sweep as the API server, so a
 * daemon-only deployment with polling off does not wait for a webhook.
 */

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

await mock.module('@propr/core', {
    namedExports: {
        generateCorrelationId: () => 'sweep-correlation-id',
        logger: { ...logger, withCorrelation: () => logger },
    },
});
await mock.module('../src/jobs/ultrafixLoopContinuation.js', {
    namedExports: { sweepUltrafixResumeCandidates: async () => [] },
});

const { runUltrafixResumeSweep, scheduleUltrafixResumeSweep } = await import('../src/daemon/ultrafixResumeSweep.js');

test('a sweep run logs resumed loops and survives a failing sweep', async () => {
    logger.info.mock.resetCalls();
    logger.warn.mock.resetCalls();
    const prId = { owner: 'acme', repo: 'web', pr: 7 };
    const sweep = mock.fn(async (_redis: unknown, createLogger: () => unknown) => {
        assert.equal(createLogger(), logger);
        return [{ prId, result: { continued: true, reason: 'deferred_resumed' } }, { prId, result: { continued: false, reason: 'still_deferred' } }];
    });

    await runUltrafixResumeSweep({} as never, sweep as never);
    assert.equal(sweep.mock.callCount(), 1);
    assert.equal(logger.info.mock.callCount(), 1, 'only resumed loops are logged');

    await runUltrafixResumeSweep({} as never, (async () => { throw new Error('redis unavailable'); }) as never);
    assert.equal(logger.warn.mock.callCount(), 1);
});

test('the schedule sweeps at once, then on every tick without overlapping a slow run', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        let release: (() => void) | undefined;
        const sweep = mock.fn(() => new Promise<never[]>(resolve => { release = () => resolve([]); }));
        const interval = scheduleUltrafixResumeSweep({} as never, { intervalMs: 1_000, sweep: sweep as never });

        assert.equal(sweep.mock.callCount(), 1, 'runs at startup');
        mock.timers.tick(1_000);
        assert.equal(sweep.mock.callCount(), 1, 'a run still in progress is not overlapped');

        release?.();
        await new Promise(resolve => setImmediate(resolve));
        mock.timers.tick(1_000);
        assert.equal(sweep.mock.callCount(), 2);
        // Each run takes the shared sweep lease for one period.
        assert.deepEqual((sweep.mock.calls[1].arguments as unknown[])[2], { leaseMs: 1_000 });
        clearInterval(interval);
    } finally {
        mock.timers.reset();
    }
});

test('the daemon schedules the sweep and stops it on shutdown', async () => {
    const daemon = await readFile(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    assert.match(daemon, /const ultrafixResumeSweepInterval = scheduleUltrafixResumeSweep\(redisClient\);/);
    assert.match(daemon, /clearInterval\(ultrafixResumeSweepInterval\);/);
});
