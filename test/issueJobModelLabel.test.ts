import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { closeConnection } = await import('@propr/core');
const { getPullRequestModelLabel } = await import('../src/jobs/issueJobHelpers.js');

after(async () => {
    await closeConnection();
});

test('PR model labels retain the selected agent alias', () => {
    assert.strictEqual(
        getPullRequestModelLabel(
            { agentAlias: 'codex2', modelLabel: 'llm-codex-gpt56-sol' },
            'gpt-5.6-sol'
        ),
        'llm-codex2-gpt56-sol'
    );
});

test('PR model labels preserve dynamic labels for uncatalogued models', () => {
    const dynamicLabel = 'llm-opencode2~opencode-openai/gpt-5.5';
    assert.strictEqual(
        getPullRequestModelLabel(
            { agentAlias: 'opencode2', modelLabel: dynamicLabel },
            'opencode-openai/gpt-5.5'
        ),
        dynamicLabel
    );
});
