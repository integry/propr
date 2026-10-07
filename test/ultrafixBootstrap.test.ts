/**
 * `/ultrafix` reaches the loop through `createUltrafixDeps().startLoop` (API
 * server) or the daemon's own dependency wiring. The command-path tests mock
 * `startLoop`, so these check that the real wiring keeps the instructions and
 * starting user that a recovered loop later re-applies.
 */

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createUltrafixRedis } from './fixtures/ultrafixRedisDouble.js';

await mock.module('@propr/core', {
    namedExports: {
        loadUltrafixRatingGoal: async () => 8,
        loadUltrafixMaxCycles: async () => 5,
        loadUltrafixPauseSeconds: async () => 30,
        loadPrReviewModel: async () => '',
    },
});
await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: { getPendingReviewState: async () => ({ hasPendingReview: false }) },
});

const { createUltrafixDeps } = await import('../src/jobs/ultrafixBootstrap.js');
const { invalidateUltrafixAutomaticWork, loadState } = await import('../src/jobs/ultrafixOrchestrationService.js');

test('the bootstrap startLoop keeps the instructions and the user that started the loop', async () => {
    const redis = createUltrafixRedis();
    const deps = createUltrafixDeps();
    const workEpoch = await deps.reserveAutomaticWork(redis as never, 'acme', 'web', 7);

    await deps.startLoop(redis as never, {
        owner: 'acme', repo: 'web', pr: 7, goal: 8, maxCycles: 5, pauseSeconds: 30, reviewModel: '',
        workEpoch, sourceCommentId: 11, instructions: 'Keep the public API stable.', userId: '42',
    }, false);

    const state = await loadState(redis as never, 'acme', 'web', 7);
    assert.equal(state?.instructions, 'Keep the public API stable.');
    assert.equal(state?.userId, '42');
    assert.equal(state?.workEpoch, workEpoch);
    assert.equal(state?.active, true);
});

test('a startup superseded before its state commit writes nothing', async () => {
    const redis = createUltrafixRedis();
    const deps = createUltrafixDeps();
    const workEpoch = await deps.reserveAutomaticWork(redis as never, 'acme', 'web', 8);
    await invalidateUltrafixAutomaticWork(redis as never, 'acme', 'web', 8);

    await assert.rejects(
        deps.startLoop(redis as never, { owner: 'acme', repo: 'web', pr: 8, workEpoch, instructions: 'x', userId: '1' }, false),
        /superseded/,
    );
    assert.equal(await loadState(redis as never, 'acme', 'web', 8), null);
});

test('the daemon wires the same startLoop, unwrapped', async () => {
    const daemon = await readFile(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const deps = /setUltrafixDeps\(\{([\s\S]*?)\}\);/.exec(daemon)?.[1] ?? '';
    // Passed through as-is, so every StartLoopOptions field reaches the loop.
    assert.match(deps, /^\s*startLoop,\s*$/m);
});
