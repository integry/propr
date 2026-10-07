/**
 * Wiring of `initializeUltrafix` (API server): the check hook resumes the PR's
 * loop, and the resume sweep runs once at startup and then every minute.
 */

import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
const setUltrafixDeps = mock.fn();
let checkHook: ((owner: string, repo: string, pr: number, headSha: string) => Promise<void>) | null = null;
const setUltrafixCheckRunHook = mock.fn((hook: typeof checkHook) => { checkHook = hook; });
const areAllChecksPassing = async () => true;
const getCurrentPRHead = async () => 'head';
const getCheckRunsStatusForRepo = async () => ({ count: 0, allPassing: true, anyPending: false, anyFailed: false });

await mock.module('@propr/core', {
    namedExports: {
        setUltrafixDeps,
        setUltrafixCheckRunHook,
        generateCorrelationId: () => 'init-correlation-id',
        logger: { ...logger, withCorrelation: () => logger },
        areAllChecksPassing,
        getCurrentPRHead,
        getCheckRunsStatusForRepo,
    },
});

const jobsDir = path.resolve(process.cwd(), 'src/jobs');
await mock.module(pathToFileURL(path.join(jobsDir, 'ultrafixBootstrap.ts')).href, {
    namedExports: { createUltrafixDeps: () => ({ marker: 'deps' }) },
});

const setCheckRunDeps = mock.fn();
const resumeDeferredContinuation = mock.fn(async () => ({ continued: true, reason: 'deferred_resumed' }));
let sweepFails = false;
const sweepUltrafixResumeCandidates = mock.fn(async (_redis: unknown, createLogger: () => unknown) => {
    if (sweepFails) throw new Error('redis unavailable');
    createLogger();
    return [{ prId: { owner: 'acme', repo: 'web', pr: 7 }, result: { continued: true, reason: 'stranded_loop_rearmed' } }];
});
await mock.module(pathToFileURL(path.join(jobsDir, 'ultrafixLoopContinuation.ts')).href, {
    namedExports: { setCheckRunDeps, resumeDeferredContinuation, sweepUltrafixResumeCandidates },
});

mock.timers.enable({ apis: ['setInterval'] });
after(() => mock.timers.reset());

const { initializeUltrafix } = await import('../packages/api/services/ultrafixInit.ts');

test('initializeUltrafix wires the check hook and the periodic resume sweep', async () => {
    const redis = { marker: 'redis' };

    await initializeUltrafix(redis as never);

    assert.deepEqual(setUltrafixDeps.mock.calls[0].arguments, [{ marker: 'deps' }]);
    assert.deepEqual(setCheckRunDeps.mock.calls[0].arguments, [{ areAllChecksPassing, getCurrentPRHead, getCheckRunsStatus: getCheckRunsStatusForRepo }]);
    assert.equal(logger.error.mock.callCount(), 0);

    // The sweep runs once at startup, against the server's Redis client.
    assert.equal(sweepUltrafixResumeCandidates.mock.callCount(), 1);
    assert.equal(sweepUltrafixResumeCandidates.mock.calls[0].arguments[0], redis);

    // Check events resume the PR's loop through the hook.
    assert.ok(checkHook);
    await checkHook('acme', 'web', 7, 'green-sha');
    assert.deepEqual(resumeDeferredContinuation.mock.calls[0].arguments.slice(0, 2), [{ owner: 'acme', repo: 'web', pr: 7 }, redis]);

    // Then every minute; a failing sweep is logged and the next one still runs.
    sweepFails = true;
    mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sweepUltrafixResumeCandidates.mock.callCount(), 2);
    assert.ok(logger.warn.mock.calls.some(call => String(call.arguments[1]).includes('sweep failed')));

    sweepFails = false;
    mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sweepUltrafixResumeCandidates.mock.callCount(), 3);

    // A second initialization does not start a second sweep loop.
    await initializeUltrafix(redis as never);
    assert.equal(sweepUltrafixResumeCandidates.mock.callCount(), 3);
    mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sweepUltrafixResumeCandidates.mock.callCount(), 4);
});
