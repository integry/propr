import { test, describe } from 'node:test';
import assert from 'node:assert';

const { buildReviewComment } = await import('../src/jobs/reviewCommentFormatter.js');

describe('buildReviewComment', () => {
    test('includes files omitted from the review diff', () => {
        const comment = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response: '## Overall Evaluation\nLooks focused.\n\n## Findings\n✅ **Positive** — Fine.\n\n## Score\n**Score: 8/10**',
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1200,
                success: true,
            },
            'https://gitfix.dev/tasks/task-1',
            { omittedDiffFiles: ['package-lock.json', 'assets/logo.png'] },
        );

        assert.ok(comment.includes('<summary>Files omitted from review diff</summary>'));
        assert.ok(comment.includes('`package-lock.json`'));
        assert.ok(comment.includes('`assets/logo.png`'));
    });
});
