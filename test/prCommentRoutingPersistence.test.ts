import { test } from 'node:test';
import assert from 'node:assert';

import { buildProviderLimitRetryJobData } from '../src/jobs/prCommentRouting.js';

test('provider-limit retry reconstruction preserves explicit slash-command routing', () => {
    const retry = buildProviderLimitRetryJobData({
        pullRequestNumber: 42,
        repoOwner: 'integry',
        repoName: 'propr',
        correlationId: 'routing-test',
        comments: [],
        llm: 'gpt-5.6-sol',
        agentAlias: 'codex',
        modelName: 'gpt-5.6-sol',
        modelLabel: 'llm-codex-gpt56-sol',
    });

    assert.strictEqual(retry.isRetryFromRateLimit, true);
    assert.strictEqual(retry.agentAlias, 'codex');
    assert.strictEqual(retry.modelName, 'gpt-5.6-sol');
    assert.strictEqual(retry.modelLabel, 'llm-codex-gpt56-sol');
    assert.strictEqual(retry.llm, 'gpt-5.6-sol');
});
