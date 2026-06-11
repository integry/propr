import { test, describe, after } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

const { shouldEnqueueExecutionAnalysis, closeConnection } = await import('@propr/core');

after(async () => {
    try { await closeConnection(); } catch { /* ignore */ }
});

describe('shouldEnqueueExecutionAnalysis (post-execution analysis recursion guard)', () => {
    test('enqueues analysis only for real implementation runs', () => {
        // Implementation executions are recorded with no explicit executionType.
        assert.strictEqual(shouldEnqueueExecutionAnalysis(undefined), true);
        assert.strictEqual(shouldEnqueueExecutionAnalysis(null), true);
        assert.strictEqual(shouldEnqueueExecutionAnalysis('implementation'), true);
    });

    test('NEVER enqueues for the analysis itself (the recursion that wedged prod)', () => {
        assert.strictEqual(shouldEnqueueExecutionAnalysis('task-analysis'), false);
    });

    test('excludes all other non-commit-producing execution types', () => {
        for (const t of [
            'pr-review',
            'summarization',
            'title-generation',
            'context-analysis',
            'repo-chat',
            'repo-improvements',
            'plan-generation',
            'plan-refinement',
            'lightweight-analysis',
            'other',
        ]) {
            assert.strictEqual(shouldEnqueueExecutionAnalysis(t), false, `${t} must not trigger analysis`);
        }
    });
});
