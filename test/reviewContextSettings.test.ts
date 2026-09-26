import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';

await mock.module('@propr/core', {
    namedExports: {
        AGENT_TYPES: [],
        db: {},
        toProprOpenCodeModelId: (model: string) => model,
        validateAgentType: () => ({ ok: false, error: 'not used by this test' }),
        validateModelReasoningLevel: () => ({ valid: true, value: '' }),
        validatePrReviewModelValue: async (model: string) => model.includes(' ')
            ? { valid: false, error: 'pr_review_model contains invalid characters' }
            : { valid: true },
    },
});

const { saveSettingsWithRollback } = await import('../packages/api/routes/configRoutesSettings.js');

const unusedDependencies = {
    publishConfigUpdate: async () => undefined,
    configStore: {} as never,
    database: {} as never,
};

describe('PR review context setting validation', () => {
    test('rejects a non-boolean enable switch before persistence', async () => {
        const result = await saveSettingsWithRollback({
            settings: { pr_review_context_enabled: 'false' },
            ...unusedDependencies,
        });
        assert.equal(result.status, 400);
        assert.equal(result.body.error, 'pr_review_context_enabled must be a boolean');
    });

    test('rejects an unsafe explicit context limit before persistence', async () => {
        const result = await saveSettingsWithRollback({
            settings: { pr_review_max_context_tokens: 9999 },
            ...unusedDependencies,
        });
        assert.equal(result.status, 400);
        assert.match(String(result.body.error), /must be 0 \(no legacy cap\)/);
    });

    for (const invalid of [0, 5, 15, 110, 50.5, '50', null]) {
        test(`rejects review context budget percentage ${JSON.stringify(invalid)} before persistence`, async () => {
            const result = await saveSettingsWithRollback({
                settings: { pr_review_context_budget_percent: invalid },
                ...unusedDependencies,
            });
            assert.equal(result.status, 400);
            assert.match(String(result.body.error), /pr_review_context_budget_percent must be one of 10, 20, 30, 40, 50, 60, 70, 80, 90, 100/);
        });
    }

    test('reports context-scout model validation errors using the context setting name', async () => {
        const result = await saveSettingsWithRollback({
            settings: { pr_review_context_model: 'invalid model' },
            ...unusedDependencies,
        });
        assert.equal(result.status, 400);
        assert.match(String(result.body.error), /pr_review_context_model contains invalid characters/);
    });
});
