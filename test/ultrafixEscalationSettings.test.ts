import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentNetworkSetting } from '../packages/core/src/network/networkPolicy.js';
await mock.module('@propr/core', { namedExports: {
    AGENT_RUN_USAGE_PAUSE_PERCENT_MIN: 50,
    AGENT_RUN_USAGE_PAUSE_PERCENT_MAX: 100,
    validateModelReasoningLevel: () => ({ valid: true, value: '' }),
    validateAgentNetworkSetting,
    validatePrReviewModelValue: async (model: string) => ({ valid: model !== 'missing', error: model === 'missing' ? 'pr_review_model is unavailable' : undefined }),
} });
const { extractSettingSaves } = await import('../packages/api/routes/configSettings.js');

test('validates and normalizes escalation fields before any saves', async () => {
    const fields = { ultrafix_escalation_enabled: true, ultrafix_escalation_models: ['codex:base', 'claude:stronger'], ultrafix_escalation_patience: 4, ultrafix_escalation_max_reasoning_levels: 0 };
    const result = await extractSettingSaves(fields);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.normalized, fields);
    assert.equal(result.saves.length, 4);
    assert.deepEqual((await extractSettingSaves({ ultrafix_escalation_models: [] })).normalized, { ultrafix_escalation_models: [] });
});

test('rejects invalid toggles, counts, lists, and unavailable models atomically', async () => {
    for (const fields of [
        { ultrafix_escalation_enabled: 'true' },
        { ultrafix_escalation_patience: 0 },
        { ultrafix_escalation_patience: 1.5 },
        { ultrafix_escalation_max_reasoning_levels: -1 },
        { ultrafix_escalation_models: 'base' },
        { ultrafix_escalation_models: [' '] },
        { ultrafix_escalation_models: ['missing'] },
    ]) {
        const result = await extractSettingSaves({ ultrafix_rating_goal: 8, ...fields });
        assert.ok(result.error);
        assert.deepEqual(result.saves, []);
    }
});

test('validates and normalizes the implementation escalation group like the Ultrafix one', async () => {
    const fields = { implementation_escalation_enabled: true, implementation_escalation_models: [' claude:stronger ', 'claude:stronger'], implementation_escalation_max_reasoning_levels: 0, implementation_escalation_validation_followup: false };
    const result = await extractSettingSaves(fields);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.normalized, { ...fields, implementation_escalation_models: ['claude:stronger'] });
    assert.equal(result.saves.length, 4);
    for (const invalid of [
        { implementation_escalation_enabled: 1 },
        { implementation_escalation_validation_followup: 'true' },
        { implementation_escalation_max_reasoning_levels: -1 },
        { implementation_escalation_models: ['missing'] },
    ]) {
        const rejected = await extractSettingSaves({ ultrafix_rating_goal: 8, ...invalid });
        assert.match(rejected.error ?? '', /implementation_escalation_/);
        assert.deepEqual(rejected.saves, []);
    }
});
