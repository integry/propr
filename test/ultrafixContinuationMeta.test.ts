import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeConnection } from '@propr/core';
import { buildContinuationMeta, buildUltrafixHistoryMeta } from '../src/jobs/ultrafixContinuationMeta.js';

after(closeConnection);

test('terminal ultrafix metadata omits unknown scores instead of fabricating zero', () => {
    const unknown = buildContinuationMeta({
        continued: false, reason: 'Stopped', outcome: 'stopped', score: null, cycleCount: 2,
    });
    assert.equal('ultrafixScore' in unknown, false);
    assert.equal(unknown.ultrafixCycleCount, 2);
    assert.equal(unknown.ultrafixOutcome, 'stopped');

    const actualZero = buildContinuationMeta({
        continued: false, reason: 'Exhausted', outcome: 'cycles_exhausted', score: 0, cycleCount: 3,
    });
    assert.equal(actualZero.ultrafixScore, 0);
});

test('fix-first history metadata numbers each action from its independent count', () => {
    const ultrafixMeta = { mode: 'ultrafix' as const, workEpoch: 7, goal: 9, maxCycles: 3 };
    assert.equal(buildUltrafixHistoryMeta(ultrafixMeta, {
        cycleCount: 0, reviewCount: 0, fixCount: 0,
    }, 'fix').ultrafixCycle, 1);
    assert.equal(buildUltrafixHistoryMeta(ultrafixMeta, {
        cycleCount: 0, reviewCount: 0, fixCount: 1,
    }, 'review').ultrafixCycle, 1);
});
