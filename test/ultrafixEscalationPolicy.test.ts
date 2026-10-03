import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getReasoningLevelsForAgentType } from '../packages/shared/src/reasoningLevels.js';
import { advanceEscalation, type UltrafixEscalationState } from '../src/jobs/ultrafixEscalationPolicy.js';

function state(overrides: Partial<UltrafixEscalationState> = {}): UltrafixEscalationState {
    return {
        models: ['base', 'stronger'], patience: 2, maxReasoningLevels: 2,
        modelIndex: 0, current: { model: 'base', levels: ['low', 'medium', 'high'], effort: 'low' },
        climbs: 0, bestScore: null, stalledReviews: 0, exhausted: false, ...overrides,
    };
}
const available = async (model: string) => ({ model, levels: getReasoningLevelsForAgentType('claude'), effort: 'medium' as const });

test('equal and lower scores stall; strict improvement resets; best survives handoff', async () => {
    const s = state();
    await advanceEscalation(s, 6, available);
    await advanceEscalation(s, 6, available);
    assert.equal(s.stalledReviews, 1);
    await advanceEscalation(s, 7, available);
    assert.equal(s.stalledReviews, 0);
    await advanceEscalation(s, 6, available);
    await advanceEscalation(s, 7, available);
    assert.equal(s.current.effort, 'medium');
    assert.equal(s.bestScore, 7);
    assert.equal(s.stalledReviews, 0);
});

test('climbs at most N then hands off at its own base effort and fresh patience', async () => {
    const s = state({ patience: 1, maxReasoningLevels: 1, bestScore: 6 });
    await advanceEscalation(s, 6, available);
    assert.equal(s.current.effort, 'medium');
    await advanceEscalation(s, 6, available);
    assert.equal(s.current.model, 'stronger');
    assert.equal(s.current.effort, 'medium');
    assert.equal(s.climbs, 0);
    assert.equal(s.bestScore, 6);
    await advanceEscalation(s, 6, available);
    assert.equal(s.current.effort, 'high');
    await advanceEscalation(s, 6, available);
    assert.equal(s.exhausted, true);
});

test('N=0 with patience=4 never touches the reasoning dial', async () => {
    const s = state({ maxReasoningLevels: 0, patience: 4, bestScore: 6 });
    for (let i = 0; i < 3; i++) await advanceEscalation(s, 6, available);
    assert.equal(s.current.effort, 'low');
    assert.equal(s.modelIndex, 0);
    await advanceEscalation(s, 6, available);
    assert.equal(s.current.model, 'stronger');
    assert.equal(s.climbs, 0);
});

test('two-tier provider switches its encoded model effort then exhausts', async () => {
    const model = 'antigravity:antigravity-gemini-3.1-pro-low';
    const s = state({ models: [model], patience: 1, bestScore: 6, maxReasoningLevels: 10,
        current: { model, levels: getReasoningLevelsForAgentType('antigravity', model), effort: 'low', effortInModel: true } });
    await advanceEscalation(s, 6, available);
    assert.equal(s.current.effort, 'high');
    assert.equal(s.current.model, 'antigravity:antigravity-gemini-3.1-pro-high');
    await advanceEscalation(s, 6, available);
    assert.equal(s.exhausted, true);
    assert.equal(s.climbs, 1);
});

test('single-tier GPT-OSS immediately hands off once stalled', async () => {
    const s = state({ patience: 1, bestScore: 6, current: { model: 'oss', levels: getReasoningLevelsForAgentType('antigravity', 'antigravity-gpt-oss-120b-medium'), effort: 'medium' } });
    await advanceEscalation(s, 6, available);
    assert.equal(s.current.model, 'stronger');
});

test('skips unavailable or near-limit models, exhausts when none remain', async () => {
    const s = state({ models: ['base', 'limited', 'available'], patience: 1, maxReasoningLevels: 0, bestScore: 6 });
    const visited: string[] = [];
    await advanceEscalation(s, 6, async model => {
        visited.push(model);
        return model === 'limited' ? null : available(model);
    });
    assert.deepEqual(visited, ['limited', 'available']);
    assert.equal(s.current.model, 'available');
    await advanceEscalation(s, 6, available);
    assert.equal(s.exhausted, true);
});
