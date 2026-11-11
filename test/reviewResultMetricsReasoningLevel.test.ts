import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const recorded: Array<{ options: Record<string, unknown> }> = [];
await mock.module('@propr/core', { namedExports: {
    recordLLMMetrics: async (_result: unknown, _issueRef: unknown, options: Record<string, unknown>) => { recorded.push({ options }); },
} });
const { recordReviewMetrics } = await import('../src/jobs/reviewResultMetrics.js');

test('review metrics carry each reviewer\'s effective reasoning level, and none when the agent reported none', async () => {
    await recordReviewMetrics([
        { assignment: { model: 'gpt-5.6' }, analysisResult: { success: true, response: 'Score: 8/10', modelUsed: 'gpt-5.6', executionTimeMs: 10, reasoningLevel: 'xhigh' } },
        { assignment: { model: 'gemini-3-pro-high' }, analysisResult: { success: false, response: '', modelUsed: 'gemini-3-pro-high', executionTimeMs: 5, error: 'boom' } },
    ], { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'repo', correlationId: 'correlation-1', taskId: 'review-1' });
    assert.deepEqual(recorded.map(entry => entry.options.reasoningLevel), ['xhigh', undefined]);
    assert.equal(recorded[0].options.executionType, 'pr-review');
});
