import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const recorded: Array<{ result: Record<string, unknown>; options: Record<string, unknown> }> = [];
await mock.module('@propr/core', { namedExports: {
    recordLLMMetrics: async (result: Record<string, unknown>, _issueRef: unknown, options: Record<string, unknown>) => { recorded.push({ result, options }); },
} });
const { recordReviewMetrics } = await import('../src/jobs/reviewResultMetrics.js');

test('review metrics carry each reviewer\'s effective reasoning level, and none when the agent reported none', async () => {
    recorded.length = 0;
    await recordReviewMetrics([
        { assignment: { model: 'gpt-5.6' }, analysisResult: { success: true, response: 'Score: 8/10', modelUsed: 'gpt-5.6', executionTimeMs: 10, reasoningLevel: 'xhigh' } },
        { assignment: { model: 'gemini-3-pro-high' }, analysisResult: { success: false, response: '', modelUsed: 'gemini-3-pro-high', executionTimeMs: 5, error: 'boom' } },
    ], { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'repo', correlationId: 'correlation-1', taskId: 'review-1' });
    assert.deepEqual(recorded.map(entry => entry.options.reasoningLevel), ['xhigh', undefined]);
    assert.equal(recorded[0].options.executionType, 'pr-review');
});

test('review metrics forward providerCostUsd, including zero, for unlisted models', async () => {
    recorded.length = 0;
    await recordReviewMetrics([
        { assignment: { model: 'opencode-litellm/custom/unlisted' }, analysisResult: { success: true, response: 'Score: 9/10', modelUsed: 'opencode-litellm/custom/unlisted', executionTimeMs: 10, providerCostUsd: 1.25 } },
        { assignment: { model: 'opencode-litellm/custom/free' }, analysisResult: { success: true, response: 'Score: 8/10', modelUsed: 'opencode-litellm/custom/free', executionTimeMs: 10, providerCostUsd: 0 } },
        { assignment: { model: 'gpt-5.6' }, analysisResult: { success: true, response: 'Score: 7/10', modelUsed: 'gpt-5.6', executionTimeMs: 10 } },
    ], { pullRequestNumber: 8, repoOwner: 'acme', repoName: 'repo', correlationId: 'correlation-2', taskId: 'review-2' });
    assert.equal(recorded[0].result.providerCostUsd, 1.25);
    assert.equal(recorded[1].result.providerCostUsd, 0);
    assert.equal('providerCostUsd' in recorded[2].result, false);
});
