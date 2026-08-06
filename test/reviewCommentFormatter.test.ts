import { after, test, describe } from 'node:test';
import assert from 'node:assert';

const { buildReviewComment } = await import('../src/jobs/reviewCommentFormatter.js');
const { parseStructuredReview } = await import('../src/jobs/reviewOutputParser.js');
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

    test('publishes concise suggestion headings without legacy metadata', () => {
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

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response,
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );
        assert.ok(formatted.includes('### S1: Add an outbox'));
        assert.ok(formatted.includes('### S2: Add a benchmark'));
        assert.ok(!formatted.includes('summary:'));
        assert.ok(!formatted.includes('autoFix:'));
    });

    test('publishes validated blockers with reader-facing sections and labels', () => {
        const response = [
            '## Overall Evaluation',
            'Cancellation needs one correction before merge.',
            '',
            '## Actionable Findings',
            '### F1: Retry transitions can overwrite cancellation',
            '- **violatedRequirement:** Cancellation must not be overwritten by another state writer.',
            '- **evidence:** workerStateManager.ts:130 — retry metadata bypasses terminal-state protection.',
            '- **introducedByPR:** true — this PR added the retry exception.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Keep cancelled tasks immutable and add a cancellation-versus-retry test.',
            '',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '',
            '## Score',
            'Score: 6/10',
            'The cancellation race blocks merging.',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response,
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );

        assert.ok(formatted.includes('## Merge blockers'));
        assert.ok(formatted.includes('Every finding below was introduced by this PR and must be resolved before merging.'));
        assert.ok(formatted.includes('- **Required behavior:** Cancellation must not be overwritten'));
        assert.ok(formatted.includes('- **Evidence:** workerStateManager.ts:130'));
        assert.ok(formatted.includes('- **Minimum fix:** Keep cancelled tasks immutable'));
        assert.ok(formatted.includes('## Suggestions\n\nThese are optional follow-ups and are not sent to `/fix`.'));
        assert.ok(!formatted.includes('## Actionable Findings'));
        assert.ok(!formatted.includes('Suggestions and Follow-ups'));
        assert.doesNotMatch(formatted, /violatedRequirement|introducedByPR|requiredForMerge|minimumCorrection/);

        const reparsed = parseStructuredReview(formatted);
        assert.strictEqual(reparsed.status, 'valid_with_blockers');
        assert.strictEqual(reparsed.actionableFindings[0].id, 'F1');
        assert.strictEqual(reparsed.actionableFindings[0].introducedByPR, true);
        assert.strictEqual(reparsed.actionableFindings[0].requiredForMerge, true);
    });

    test('does not publish internal blocker metadata from an invalid review', () => {
        const response = [
            '## Overall Evaluation',
            'Cancellation needs one correction before merge.',
            '',
            '## Actionable Findings',
            '### F1: Retry transitions can overwrite cancellation',
            '- **violatedRequirement:** Cancellation must not be overwritten by another state writer.',
            '- **introducedByPR:** true — this PR added the retry exception.',
            '- **requiredForMerge:** true',
            '- **minimumCorrection:** Keep cancelled tasks immutable.',
            '',
            '## Suggestions and Follow-ups',
            'No suggestions.',
            '',
            '## Score',
            'Score: 6/10',
        ].join('\n');

        const formatted = buildReviewComment(
            { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' },
            {
                response,
                modelUsed: 'claude-sonnet',
                executionTimeMs: 1000,
                success: true,
            },
        );

        assert.ok(formatted.includes('Review output was invalid and could not be displayed safely.'));
        assert.doesNotMatch(formatted, /violatedRequirement|introducedByPR|requiredForMerge|minimumCorrection/);
        assert.strictEqual(parseStructuredReview(formatted).status, 'invalid');
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
