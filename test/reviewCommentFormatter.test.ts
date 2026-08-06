import { after, test, describe } from 'node:test';
import assert from 'node:assert';

const { buildReviewComment, markSuggestionsNonAutomatic } = await import('../src/jobs/reviewCommentFormatter.js');
const { closeConnection } = await import('@propr/core');

after(async () => {
    await closeConnection();
});

describe('buildReviewComment', () => {
    test('explains that explicit finding IDs refer to the newest review', () => {
        const comment = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response: '## Actionable Findings\nNo actionable findings.\n\n## Score\nScore: 10/10',
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );

        assert.ok(comment.includes('Explicit IDs such as `/fix F1 F3` refer to the newest review.'));
        assert.ok(comment.includes('require a separate ordinary follow-up request.'));
        assert.ok(!comment.includes('/fix include S'));
    });

    test('publishes suggestions while forcing autoFix false', () => {
        const response = [
            '## Overall Evaluation',
            'Ready.',
            '## Actionable Findings',
            'No actionable findings.',
            '## Suggestions and Follow-ups',
            '### S1: Add an outbox',
            '- **summary:** Optional hardening',
            '- **autoFix:** true',
            '### S2: Add a benchmark',
            '- **summary:** Optional performance coverage',
            '## Score',
            'Score: 9/10',
        ].join('\n');

        const formatted = markSuggestionsNonAutomatic(response);
        assert.ok(formatted.includes('### S1: Add an outbox'));
        assert.ok(formatted.includes('### S2: Add a benchmark'));
        assert.strictEqual((formatted.match(/- \*\*autoFix:\*\* false/g) ?? []).length, 2);
        assert.ok(!formatted.includes('autoFix:** true'));
    });

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

        assert.ok(comment.includes('* **Model:** Claude Opus 4.8\n'));
        assert.ok(comment.includes('<!-- propr:ai-review model="claude-opus-4-8" -->'));
        assert.ok(comment.includes('**Tokens:** 113,016 (100,787 in / 12,229 out)'));
        assert.ok(comment.includes('**Cost:** $0.80'));
    });
});
