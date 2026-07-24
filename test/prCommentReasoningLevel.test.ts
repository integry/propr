import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PROPR_DEMO_MODE = 'true';

const { resolvePrReasoningLevelOverride } = await import('../src/jobs/prCommentJobHelpers.js');
const { buildMetricsSection } = await import('../src/jobs/prCommentMetrics.js');
const { closeConnection } = await import('../packages/core/src/db/connection.ts');

after(async () => {
    await closeConnection();
});

const logger = {
    info: () => undefined,
    warn: () => undefined,
};

const context = {
    repoOwner: 'integry',
    repoName: 'propr',
    pullRequestNumber: 1705,
    correlatedLogger: logger as never,
};

describe('PR comment reasoning level labels', () => {
    test('uses a level label from the linked issue for PR follow-up runs', () => {
        const reasoningLevel = resolvePrReasoningLevelOverride(
            [{ name: 'AI' }, { name: 'llm-codex-gpt56-sol' }],
            [{ name: 'bug' }, { name: 'level-xhigh' }],
            context,
        );

        assert.equal(reasoningLevel, 'xhigh');
    });

    test('uses a level label directly on the pull request', () => {
        const reasoningLevel = resolvePrReasoningLevelOverride(
            [{ name: 'AI' }, { name: 'level-max' }],
            [],
            context,
        );

        assert.equal(reasoningLevel, 'max');
    });

    test('prefers a PR label over a conflicting linked-issue label', () => {
        const reasoningLevel = resolvePrReasoningLevelOverride(
            [{ name: 'level-low' }],
            [{ name: 'Level-UltraCode' }],
            context,
        );

        assert.equal(reasoningLevel, 'low');
    });

    test('returns undefined when no PR or linked issue level label is present', () => {
        const reasoningLevel = resolvePrReasoningLevelOverride(
            [{ name: 'AI' }],
            [{ name: 'enhancement' }],
            context,
        );

        assert.equal(reasoningLevel, undefined);
    });
});

describe('PR comment reasoning level summary', () => {
    test('shows the effective reasoning level next to the model name', async () => {
        const section = await buildMetricsSection({
            success: true,
            model: 'gpt-5.6-sol',
            reasoningLevel: 'xhigh',
            executionTime: 0,
            output: null,
            logs: '',
            modifiedFiles: [],
            commitMessage: null,
        }, null, '@integry');

        assert.match(section, /\* \*\*Model:\*\* GPT-5\.6 Sol \(xhigh\)/);
    });

    test('keeps the model name unchanged when the runtime uses its default reasoning', async () => {
        const section = await buildMetricsSection({
            success: true,
            model: 'gpt-5.6-sol',
            executionTime: 0,
            output: null,
            logs: '',
            modifiedFiles: [],
            commitMessage: null,
        }, null, '@integry');

        assert.match(section, /\* \*\*Model:\*\* GPT-5\.6 Sol\n/);
        assert.doesNotMatch(section, /GPT-5\.6 Sol \(/);
    });
});
