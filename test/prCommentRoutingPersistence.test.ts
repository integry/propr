import { test, after } from 'node:test';
import assert from 'node:assert';

import { buildProviderLimitRetryJobData } from '../src/jobs/prCommentRouting.js';
import {
    buildProviderLimitRetryJobId,
    buildRuntimeProviderLimitRetryJobData,
} from '../src/jobs/prCommentJobUtils.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { shutdownQueue } from '../packages/core/src/queue/taskQueue.js';

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

test('provider-limit retry reconstruction preserves the full claimed comment set and explicit slash-command routing', () => {
    const retry = buildProviderLimitRetryJobData({
        pullRequestNumber: 42,
        repoOwner: 'integry',
        repoName: 'propr',
        correlationId: 'routing-test',
        comments: [
            { id: 10, body: 'normal request', author: 'alice', type: 'issue' },
            { id: 20, body: 'selected request', author: 'alice', type: 'issue', commandMode: 'use', hasCodeContext: true },
        ],
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
    assert.deepStrictEqual(retry.comments?.map(comment => comment.id), [10, 20]);
    assert.strictEqual(retry.comments?.[1].hasCodeContext, true);
});

test('ordinary provider-limit retry persists the failed attempt runtime route in its payload and identity', () => {
    const retry = buildRuntimeProviderLimitRetryJobData({
        pullRequestNumber: 42,
        repoOwner: 'integry',
        repoName: 'propr',
        branchName: 'feature/routing',
        correlationId: 'runtime-routing-test',
        comments: [{ id: 10, body: 'normal request', author: 'alice', type: 'issue' }],
        llm: 'claude-opus-4-8',
    }, {
        runtimeAgentAlias: 'codex-prod',
        runtimeModelName: 'gpt-5.6-sol',
    });

    assert.strictEqual(retry.isRetryFromRateLimit, true);
    assert.strictEqual(retry.agentAlias, 'codex-prod');
    assert.strictEqual(retry.modelName, 'gpt-5.6-sol');
    assert.strictEqual(retry.llm, 'gpt-5.6-sol');
    assert.strictEqual(
        buildProviderLimitRetryJobId(retry),
        'pr-comments-batch-integry-propr-42-codex-prod-gpt-5-6-sol-feature-routing-ratelimit-retry',
    );
});

test('provider-limit retry retains an available canonical model label', () => {
    const retry = buildRuntimeProviderLimitRetryJobData({
        pullRequestNumber: 42,
        repoOwner: 'integry',
        repoName: 'propr',
        correlationId: 'canonical-label-test',
        llm: 'gpt-5.6-sol',
        agentAlias: 'codex-prod',
        modelName: 'gpt-5.6-sol',
        modelLabel: 'llm-codex-gpt56-sol',
    }, {
        runtimeAgentAlias: 'codex-prod',
        runtimeModelName: 'gpt-5.6-sol',
    });

    assert.strictEqual(retry.modelLabel, 'llm-codex-gpt56-sol');
});
