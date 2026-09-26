import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImplementationPrUltrafixTrigger } from '../src/jobs/implementationPrUltrafix.js';

describe('implementation PR Ultrafix trigger', () => {
    test('uses normal defaults for a source-issue label-only opt-in', () => {
        const trigger = resolveImplementationPrUltrafixTrigger(
            [{ name: 'AI' }, { name: 'ultrafix' }],
            { runUltrafix: false, goal: null, maxCycles: null },
        );

        assert.deepStrictEqual(trigger, { goal: null, maxCycles: null });
    });

    test('uses Planner overrides for a Planner-only opt-in', () => {
        const trigger = resolveImplementationPrUltrafixTrigger(
            [{ name: 'AI' }],
            { runUltrafix: true, goal: 9, maxCycles: 3 },
        );

        assert.deepStrictEqual(trigger, { goal: 9, maxCycles: 3 });
    });

    test('combines both opt-ins into one trigger with Planner overrides', () => {
        const trigger = resolveImplementationPrUltrafixTrigger(
            [{ name: 'ultrafix' }],
            { runUltrafix: true, goal: 8, maxCycles: 4 },
        );

        assert.deepStrictEqual(trigger, { goal: 8, maxCycles: 4 });
    });

    test('does not trigger when neither input opts in', () => {
        const trigger = resolveImplementationPrUltrafixTrigger(
            [{ name: 'AI' }, { name: 'ultrafix-requested' }, { name: 'Ultrafix' }],
            { runUltrafix: false, goal: null, maxCycles: null },
        );

        assert.strictEqual(trigger, null);
    });
});
