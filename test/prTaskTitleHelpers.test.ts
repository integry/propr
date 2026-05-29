import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
    buildDeterministicPrTaskSubtitle,
    buildPrTaskTitle,
    buildPrTaskTitleContext,
    filterDiffToFiles,
    getConflictDiffForTitle,
    getPrTaskWorkflowLabel,
    hasMeaningfulTitleText,
    resolvePrTaskWorkflow,
    selectRecentUsefulPrComments,
    selectFallbackSummaryLine,
} from '../src/jobs/prTaskTitleHelpers.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd });
}

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

    test('caps long PR titles in task titles', () => {
        const title = buildPrTaskTitle({
            workflow: 'fix',
            pullRequestNumber: 123,
            prTitle: 'A'.repeat(180),
        });

        assert.ok(title.endsWith('...'));
        assert.ok(title.length < 170);
    });

    test('resolves ultrafix workflow from metadata even when the concrete step is fix or review', () => {
        assert.strictEqual(resolvePrTaskWorkflow('fix', true), 'ultrafix');
        assert.strictEqual(resolvePrTaskWorkflow('review', true), 'ultrafix');
        assert.strictEqual(resolvePrTaskWorkflow('fix', false), 'fix');
    });

    test('detects bare slash commands as not meaningful title text', () => {
        assert.strictEqual(hasMeaningfulTitleText('/fix'), false);
        assert.strictEqual(hasMeaningfulTitleText('/review claude-sonnet'), false);
        assert.strictEqual(hasMeaningfulTitleText('/review security only'), true);
        assert.strictEqual(hasMeaningfulTitleText('/merge'), false);
        assert.strictEqual(hasMeaningfulTitleText('/fix only address security issues'), true);
        assert.strictEqual(hasMeaningfulTitleText('/ultrafix only fix failing lint'), true);
    });

    test('uses the ultrafix label when metadata turns review into an ultrafix step', () => {
        const workflow = resolvePrTaskWorkflow('review', true);
        assert.strictEqual(workflow, 'ultrafix');
        assert.strictEqual(getPrTaskWorkflowLabel(workflow), 'Ultrafix');
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

    test('filters generated comments regardless of pattern casing', () => {
        const selected = selectRecentUsefulPrComments([
            {
                id: 5,
                body: 'starting work on follow-up changes',
                created_at: '2026-05-29T08:05:00Z',
                user: { login: 'propr.dev[bot]', type: 'User' },
            },
            comments[2],
        ], { limit: 2 });
        assert.deepStrictEqual(selected.map(comment => comment.id), [3]);
    });

    test('filters generated check comments from bot context', () => {
        const selected = selectRecentUsefulPrComments([
            {
                id: 6,
                body: '### Checks Failed\nLinting or build errors were detected.\n\nView Logs',
                created_at: '2026-05-29T08:06:00Z',
                user: { login: 'github-actions[bot]', type: 'Bot' },
            },
            comments[2],
        ], { limit: 2 });
        assert.deepStrictEqual(selected.map(comment => comment.id), [3]);
    });

    test('filters common deployment and coverage bot comments', () => {
        const selected = selectRecentUsefulPrComments([
            {
                id: 7,
                body: 'Preview deployment is ready for this pull request.',
                created_at: '2026-05-29T08:07:00Z',
                user: { login: 'vercel[bot]', type: 'Bot' },
            },
            {
                id: 8,
                body: 'Coverage report uploaded for commit abc123.',
                created_at: '2026-05-29T08:08:00Z',
                user: { login: 'codecov[bot]', type: 'Bot' },
            },
            comments[2],
        ], { limit: 2 });
        assert.deepStrictEqual(selected.map(comment => comment.id), [3]);
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

    test('uses the first meaningful PR description paragraph instead of checklist boilerplate', () => {
        const result = buildPrTaskTitleContext({
            workflow: 'fix',
            pullRequestNumber: 123,
            prTitle: 'Add OAuth refresh handling',
            recentComments: [],
            prDescription: [
                '<!-- remove this template before merge -->',
                '## Checklist',
                '- [ ] Added tests',
                '- [x] Updated docs',
                '',
                'The OAuth callback now needs to preserve the refresh token during retry.',
                '',
                'Closes #100',
            ].join('\n'),
        });

        assert.strictEqual(result.includedPrDescription, true);
        assert.ok(result.context.includes('preserve the refresh token'));
        assert.ok(!result.context.includes('Added tests'));
        assert.ok(!result.context.includes('Closes #100'));
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

    test('does not include PR description fallback when instructions already provide context', () => {
        const result = buildPrTaskTitleContext({
            workflow: 'review',
            pullRequestNumber: 123,
            prTitle: 'Add OAuth refresh handling',
            instructionText: '/review security only',
            recentComments: [],
            prDescription: 'This PR adds token refresh support for OAuth sessions.',
        });

        assert.strictEqual(result.includedPrDescription, false);
        assert.ok(result.context.includes('security only'));
        assert.ok(!result.context.includes('PR description fallback'));
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

    test('fallback summary selection skips generated context section labels', () => {
        const line = selectFallbackSummaryLine([
            'Task: Fix PR #123: Add OAuth refresh handling',
            '',
            'Review feedback to address:',
            '**AI Review Comments (unprocessed - please address these findings):**',
            '---',
            '**Review by:** @propr-dev[bot] (Comment ID: 1)',
            'Handle null refresh tokens before persisting the session.',
        ].join('\n'));

        assert.strictEqual(line, 'Handle null refresh tokens before persisting the session.');
    });

    test('fallback summary selection skips common structural markdown labels', () => {
        const line = selectFallbackSummaryLine([
            'Conflicting Files',
            '- Resolution Summary',
            '- Handle conflict markers in src/auth.ts.',
        ].join('\n'));

        assert.strictEqual(line, 'Handle conflict markers in src/auth.ts.');
    });

    test('fallback summary selection prefers merge conflict marker body over diff metadata', () => {
        const line = selectFallbackSummaryLine([
            'Task: Merge PR #123: Resolve auth conflicts',
            '',
            'Merge conflict diff for conflicting files only:',
            'diff --git a/src/auth.ts b/src/auth.ts',
            'index 111..222 100644',
            '--- a/src/auth.ts',
            '+++ b/src/auth.ts',
            '@@ -1 +1 @@',
            '+<<<<<<< HEAD',
            '+preserve refreshed session tokens',
            '+=======',
            '+reuse existing session tokens',
            '+>>>>>>> main',
        ].join('\n'));

        assert.strictEqual(line, 'preserve refreshed session tokens');
    });

    test('fallback summary selection uses conflicting file names when merge diff has no marker body', () => {
        const line = selectFallbackSummaryLine([
            'Task: Merge PR #123: Resolve auth conflicts',
            '',
            'Merge conflict diff for conflicting files only:',
            'diff --git a/src/auth.ts b/src/auth.ts',
            'index 111..222 100644',
            '--- a/src/auth.ts',
            '+++ b/src/auth.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n'));

        assert.strictEqual(line, 'Conflicts in src/auth.ts');
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

    test('filters quoted diff paths with spaces', () => {
        const diff = [
            'diff --git "a/src/auth flow.ts" "b/src/auth flow.ts"',
            'index 111..222 100644',
            '--- "a/src/auth flow.ts"',
            '+++ "b/src/auth flow.ts"',
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
        ].join('\n');

        const filtered = filterDiffToFiles(diff, ['src/auth flow.ts']);
        assert.ok(filtered.includes('"b/src/auth flow.ts"'));
        assert.ok(!filtered.includes('src/unrelated.ts'));
    });

    test('keeps a headerless diff when patch headers reference a conflicting file', () => {
        const diff = [
            'index aaa,bbb..ccc',
            '--- a/src/conflict.ts',
            '+++ b/src/conflict.ts',
            '@@@ -1,1 -1,1 +1,1 @@@',
            '++resolved conflict',
        ].join('\n');

        assert.strictEqual(filterDiffToFiles(diff, ['src/conflict.ts']), diff);
        assert.strictEqual(filterDiffToFiles(diff, ['src/other.ts']), '');
    });

    test('matches git diff blocks by either side of the header without malformed patch-header leakage', () => {
        const diff = [
            'diff --git a/src/old-name.ts b/src/new-name.ts',
            'similarity index 88%',
            'rename from src/old-name.ts',
            'rename to src/new-name.ts',
            '--- a/src/old-name.ts',
            '+++ b/src/new-name.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            'diff --git a/src/unrelated.ts b/src/unrelated.ts',
            'index 111..222 100644',
            '--- a/src/conflict.ts',
            '+++ b/src/conflict.ts',
            '@@ -1 +1 @@',
            '-conflict old',
            '+conflict new',
        ].join('\n');

        const renamed = filterDiffToFiles(diff, ['src/old-name.ts']);
        assert.ok(renamed.includes('rename from src/old-name.ts'));
        assert.ok(!renamed.includes('src/conflict.ts'));

        assert.strictEqual(filterDiffToFiles(diff, ['src/conflict.ts']), '');
    });

    test('reads unresolved merge conflict diff before conflicts are resolved', async () => {
        const repo = await mkdtemp(join(tmpdir(), 'propr-conflict-diff-'));
        try {
            await git(repo, ['init']);
            await git(repo, ['config', 'user.email', 'test@example.com']);
            await git(repo, ['config', 'user.name', 'ProPR Test']);
            await git(repo, ['branch', '-M', 'main']);
            await mkdir(join(repo, 'src'));
            await writeFile(join(repo, 'src/conflict.ts'), 'export const value = "base";\n');
            await git(repo, ['add', 'src/conflict.ts']);
            await git(repo, ['commit', '-m', 'base']);
            await git(repo, ['checkout', '-b', 'feature']);
            await writeFile(join(repo, 'src/conflict.ts'), 'export const value = "feature";\n');
            await git(repo, ['commit', '-am', 'feature change']);
            await git(repo, ['checkout', 'main']);
            await writeFile(join(repo, 'src/conflict.ts'), 'export const value = "main";\n');
            await git(repo, ['commit', '-am', 'main change']);
            await git(repo, ['checkout', 'feature']);

            await assert.rejects(execFileAsync('git', ['merge', 'main'], { cwd: repo }));
            const conflictDiff = await getConflictDiffForTitle(repo, ['src/conflict.ts']);

            assert.ok(conflictDiff.includes('src/conflict.ts'));
            assert.ok(conflictDiff.includes('<<<<<<<') || conflictDiff.includes('feature') || conflictDiff.includes('main'));
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
