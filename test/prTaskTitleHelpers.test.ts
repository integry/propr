import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    buildDeterministicPrTaskSubtitle,
    buildPrTaskTitle,
    buildPrTaskTitleContext,
    filterDiffToFiles,
    hasMeaningfulTitleText,
    resolvePrTaskWorkflow,
    selectRecentUsefulPrComments,
} from '../src/jobs/prTaskTitleHelpers.js';

describe('prTaskTitleHelpers titles', () => {
    test('builds command-aware PR titles', () => {
        assert.strictEqual(
            buildPrTaskTitle({ workflow: 'fix', pullRequestNumber: 123, prTitle: 'Add OAuth refresh handling' }),
            'Fix PR #123: Add OAuth refresh handling',
        );
        assert.strictEqual(
            buildPrTaskTitle({ workflow: 'review', pullRequestNumber: 123, prTitle: 'Add OAuth refresh handling' }),
            'Review PR #123: Add OAuth refresh handling',
        );
        assert.strictEqual(
            buildPrTaskTitle({ workflow: 'ultrafix', pullRequestNumber: 123, prTitle: 'Add OAuth refresh handling' }),
            'Ultrafix PR #123: Add OAuth refresh handling',
        );
        assert.strictEqual(
            buildPrTaskTitle({ workflow: 'merge', pullRequestNumber: 123, prTitle: 'Resolve auth middleware conflicts' }),
            'Merge PR #123: Resolve auth middleware conflicts',
        );
    });

    test('resolves ultrafix workflow from metadata even when the concrete step is fix or review', () => {
        assert.strictEqual(resolvePrTaskWorkflow('fix', true), 'ultrafix');
        assert.strictEqual(resolvePrTaskWorkflow('review', true), 'ultrafix');
        assert.strictEqual(resolvePrTaskWorkflow('fix', false), 'fix');
    });

    test('detects bare slash commands as not meaningful title text', () => {
        assert.strictEqual(hasMeaningfulTitleText('/fix'), false);
        assert.strictEqual(hasMeaningfulTitleText('/review claude-sonnet'), false);
        assert.strictEqual(hasMeaningfulTitleText('/merge'), false);
        assert.strictEqual(hasMeaningfulTitleText('/fix only address security issues'), true);
    });
});

describe('prTaskTitleHelpers context selection', () => {
    const comments = [
        {
            id: 1,
            body: 'Please preserve the old token migration path.',
            created_at: '2026-05-29T08:00:00Z',
            user: { login: 'alice', type: 'User' },
        },
        {
            id: 2,
            body: '/fix',
            created_at: '2026-05-29T08:01:00Z',
            user: { login: 'alice', type: 'User' },
        },
        {
            id: 3,
            body: 'The refresh token path still fails after expiry.',
            created_at: '2026-05-29T08:02:00Z',
            user: { login: 'bob', type: 'User' },
        },
        {
            id: 4,
            body: 'Starting work on follow-up changes',
            created_at: '2026-05-29T08:03:00Z',
            user: { login: 'propr.dev[bot]', type: 'Bot' },
        },
    ];

    test('selects the latest two useful PR comments and skips bare commands and generated bot comments', () => {
        const selected = selectRecentUsefulPrComments(comments, { limit: 2 });
        assert.deepStrictEqual(selected.map(comment => comment.id), [3, 1]);
    });

    test('falls back to PR description when fewer than two useful recent comments exist', () => {
        const result = buildPrTaskTitleContext({
            workflow: 'review',
            pullRequestNumber: 123,
            prTitle: 'Add OAuth refresh handling',
            recentComments: [comments[2]],
            prDescription: 'This PR adds token refresh support for OAuth sessions.',
        });

        assert.strictEqual(result.hasMeaningfulContext, true);
        assert.strictEqual(result.usefulRecentCommentCount, 1);
        assert.strictEqual(result.includedPrDescription, true);
        assert.ok(result.context.includes('The refresh token path still fails after expiry.'));
        assert.ok(result.context.includes('This PR adds token refresh support'));
    });

    test('includes meaningful slash-command instructions with recent PR context', () => {
        const result = buildPrTaskTitleContext({
            workflow: 'fix',
            pullRequestNumber: 123,
            prTitle: 'Add OAuth refresh handling',
            instructionText: 'only address security issues',
            recentComments: comments,
            prDescription: 'Fallback should not be needed when two comments are useful.',
        });

        assert.strictEqual(result.includedPrDescription, false);
        assert.ok(result.context.includes('User instructions'));
        assert.ok(result.context.includes('only address security issues'));
        assert.ok(result.context.includes('Recent useful PR comments'));
    });

    test('returns no context and a deterministic subtitle can be used when nothing is meaningful', () => {
        const result = buildPrTaskTitleContext({
            workflow: 'fix',
            pullRequestNumber: 123,
            prTitle: 'Add OAuth refresh handling',
            instructionText: '/fix',
            recentComments: [{ id: 9, body: '/review', created_at: '2026-05-29T08:04:00Z', user: { login: 'alice' } }],
            prDescription: '',
        });

        assert.strictEqual(result.hasMeaningfulContext, false);
        assert.strictEqual(result.context, '');
        assert.strictEqual(buildDeterministicPrTaskSubtitle('fix'), 'Fix requested without additional context.');
    });

    test('includes review feedback for fix title context', () => {
        const result = buildPrTaskTitleContext({
            workflow: 'fix',
            pullRequestNumber: 123,
            prTitle: 'Add OAuth refresh handling',
            reviewFeedback: '**AI Review Comments:**\nHandle null refresh tokens.',
        });

        assert.strictEqual(result.includedReviewFeedback, true);
        assert.ok(result.context.includes('Handle null refresh tokens.'));
    });
});

describe('prTaskTitleHelpers merge conflict diff context', () => {
    test('filters a diff down to conflicting files only', () => {
        const diff = [
            'diff --git a/src/auth.ts b/src/auth.ts',
            'index 111..222 100644',
            '--- a/src/auth.ts',
            '+++ b/src/auth.ts',
            '@@ -1 +1 @@',
            '-old auth',
            '+new auth',
            'diff --git a/src/unrelated.ts b/src/unrelated.ts',
            'index 333..444 100644',
            '--- a/src/unrelated.ts',
            '+++ b/src/unrelated.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            'diff --cc src/middleware.ts',
            'index aaa,bbb..ccc',
            '--- a/src/middleware.ts',
            '+++ b/src/middleware.ts',
            '@@@ -1,1 -1,1 +1,1 @@@',
            '++resolved middleware',
        ].join('\n');

        const filtered = filterDiffToFiles(diff, ['src/auth.ts', 'src/middleware.ts']);
        assert.ok(filtered.includes('diff --git a/src/auth.ts b/src/auth.ts'));
        assert.ok(filtered.includes('diff --cc src/middleware.ts'));
        assert.ok(!filtered.includes('src/unrelated.ts'));

        const result = buildPrTaskTitleContext({
            workflow: 'merge',
            pullRequestNumber: 123,
            prTitle: 'Resolve auth middleware conflicts',
            mergeConflictDiff: filtered,
        });
        assert.strictEqual(result.includedMergeConflictDiff, true);
        assert.ok(result.context.includes('Merge conflict diff for conflicting files only'));
    });
});
