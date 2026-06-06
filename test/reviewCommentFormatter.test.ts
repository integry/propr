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

    test('counts cache tokens as input tokens and includes cost', () => {
        const comment = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
            {
                response: '## Overall Evaluation\nLooks focused.\n\n## Findings\n✅ **Positive** — Fine.\n\n## Score\n**Score: 8/10**',
                modelUsed: 'claude-opus-4-8',
                executionTimeMs: 153000,
                success: true,
                tokenUsage: {
                    input_tokens: 2,
                    cache_creation_input_tokens: 97116,
                    cache_read_input_tokens: 3669,
                    output_tokens: 12229,
                },
            },
            undefined,
            { costUsd: 0.8037945 },
        );

        assert.ok(comment.includes('**Tokens:** 113,016 (100,787 in / 12,229 out)'));
        assert.ok(comment.includes('**Cost:** $0.80'));
    });
});
