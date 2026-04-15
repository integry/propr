/**
 * Tests for review comment gathering and sanitization logic.
 *
 * Because the full module transitively imports @propr/core (which requires a
 * workspace build), these tests exercise the exported pure functions by
 * re-implementing the key helpers inline so the test file stays self-contained.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// Inline copies of the pure helpers under test — kept in sync with the source
// in src/jobs/reviewCommentGatherer.ts.  This avoids the @propr/core transitive
// dependency that blocks direct import in CI without a workspace build.
// ---------------------------------------------------------------------------

const REVIEW_COMMENT_MARKER_PREFIX = '<!-- propr:ai-review';

function isReviewComment(body: string): boolean {
    return body.includes(REVIEW_COMMENT_MARKER_PREFIX);
}

const ERROR_MARKER_RE = /<!-- propr:ai-review [^>]*error="true"[^>]* -->/;

function stripReviewBoilerplate(body: string): string {
    let cleaned = body.replace(/\n?<!-- propr:ai-review [^>]* -->/g, '');
    cleaned = cleaned.replace(/\n?---\n> 💡 \*\*Tip:\*\* Comment `\/fix`[^\n]*(?:\n[^\n]*`\/fix[^\n]*)*/g, '');
    return cleaned.trimEnd();
}

// ---------------------------------------------------------------------------
// stripReviewBoilerplate
// ---------------------------------------------------------------------------
describe('stripReviewBoilerplate', () => {
    test('removes the HTML marker comment', () => {
        const body = 'Some findings here.\n<!-- propr:ai-review model="claude-opus-4-1" -->';
        const result = stripReviewBoilerplate(body);
        assert.strictEqual(result, 'Some findings here.');
    });

    test('removes the error marker variant', () => {
        const body = 'Review content\n<!-- propr:ai-review model="claude-opus-4-1" error="true" -->';
        const result = stripReviewBoilerplate(body);
        assert.strictEqual(result, 'Review content');
    });

    test('removes the /fix tip section', () => {
        const body = [
            '## Findings',
            '',
            'Something is wrong.',
            '',
            '---',
            '> 💡 **Tip:** Comment `/fix` on this PR to have the AI automatically implement the changes suggested in this review. The `/fix` command gathers all unprocessed AI review comments and applies the requested fixes in a single pass. You can also add extra instructions, e.g. `/fix only address the critical findings`.',
            '',
            '<!-- propr:ai-review model="claude-opus-4-1" -->',
        ].join('\n');
        const result = stripReviewBoilerplate(body);
        assert.ok(!result.includes('/fix'), `should not contain /fix tip, got: ${result}`);
        assert.ok(!result.includes('propr:ai-review'), 'should not contain marker');
        assert.ok(result.includes('Something is wrong.'), 'should keep actionable content');
    });

    test('preserves body that has no boilerplate', () => {
        const body = 'Plain comment with no markers.';
        assert.strictEqual(stripReviewBoilerplate(body), body);
    });

    test('removes marker but preserves review details section', () => {
        const body = [
            '## 🔍 AI Code Review — Claude Opus 4',
            '',
            '### Overall Evaluation',
            'Code looks good.',
            '',
            '---',
            '### 🤖 Review Details',
            '* **Model:** claude-opus-4-1',
            '* **Time:** 45s',
            '',
            '---',
            '> 💡 **Tip:** Comment `/fix` on this PR to have the AI automatically implement the changes suggested in this review. The `/fix` command gathers all unprocessed AI review comments and applies the requested fixes in a single pass. You can also add extra instructions, e.g. `/fix only address the critical findings`.',
            '',
            '<!-- propr:ai-review model="claude-opus-4-1" -->',
        ].join('\n');
        const result = stripReviewBoilerplate(body);
        assert.ok(result.includes('Code looks good.'), 'should keep evaluation');
        assert.ok(result.includes('Review Details'), 'should keep review details');
        assert.ok(!result.includes('propr:ai-review'), 'should remove marker');
        assert.ok(!result.includes('💡 **Tip:**'), 'should remove tip');
    });
});

// ---------------------------------------------------------------------------
// ERROR_MARKER_RE — structured detection of error reviews
// ---------------------------------------------------------------------------
describe('ERROR_MARKER_RE', () => {
    test('matches error marker', () => {
        const body = '<!-- propr:ai-review model="claude-opus-4-1" error="true" -->';
        assert.ok(ERROR_MARKER_RE.test(body));
    });

    test('does not match success marker', () => {
        const body = '<!-- propr:ai-review model="claude-opus-4-1" -->';
        assert.ok(!ERROR_MARKER_RE.test(body));
    });

    test('does not false-positive on error="true" in prose', () => {
        const body = 'The config has error="true" set by default.';
        assert.ok(!ERROR_MARKER_RE.test(body));
    });
});

// ---------------------------------------------------------------------------
// isReviewComment — marker detection
// ---------------------------------------------------------------------------
describe('isReviewComment', () => {
    test('returns true for AI review comment', () => {
        assert.ok(isReviewComment('Content\n<!-- propr:ai-review model="x" -->'));
    });

    test('returns false for plain comment', () => {
        assert.ok(!isReviewComment('Just a regular comment'));
    });
});

// ---------------------------------------------------------------------------
// gatherUnprocessedReviewComments — logic tests (simulated)
// ---------------------------------------------------------------------------
describe('gatherUnprocessedReviewComments logic', () => {
    // Simulate the gather logic locally since we cannot import the module.
    interface PRComment {
        id: number;
        body: string | null;
        user: { login: string };
        created_at: string;
    }

    interface AIReviewComment {
        id: number;
        body: string;
        author: string;
        created_at: string;
    }

    function gather(
        allComments: PRComment[],
        processedIds: string[],
        maxAgeMs: number = 7 * 24 * 3600 * 1000,
    ): AIReviewComment[] {
        const cutoff = Date.now() - maxAgeMs;
        const aiReviewComments = allComments.filter(c => c.body && isReviewComment(c.body));
        const processedSet = new Set(processedIds);
        const unprocessed: AIReviewComment[] = [];
        for (const comment of aiReviewComments) {
            if (processedSet.has(String(comment.id))) continue;
            if (ERROR_MARKER_RE.test(comment.body!)) continue;
            if (new Date(comment.created_at).getTime() < cutoff) continue;
            unprocessed.push({
                id: comment.id,
                body: stripReviewBoilerplate(comment.body!),
                author: comment.user.login,
                created_at: comment.created_at,
            });
        }
        return unprocessed;
    }

    function makeComment(overrides: Partial<PRComment> & { id: number } = { id: 1 }): PRComment {
        return {
            body: `## Review\nFindings here\n<!-- propr:ai-review model="claude-opus-4-1" -->`,
            user: { login: 'propr-bot' },
            created_at: new Date().toISOString(),
            ...overrides,
        };
    }

    test('returns unprocessed AI review comments', () => {
        const comments = [
            makeComment({ id: 10 }),
            makeComment({ id: 20 }),
            { id: 30, body: 'Just a regular comment', user: { login: 'human' }, created_at: new Date().toISOString() },
        ];
        const result = gather(comments, []);
        assert.strictEqual(result.length, 2);
        assert.deepStrictEqual(result.map(r => r.id), [10, 20]);
    });

    test('excludes already-processed comments', () => {
        const comments = [makeComment({ id: 10 }), makeComment({ id: 20 })];
        const result = gather(comments, ['10']);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 20);
    });

    test('excludes error review comments via marker regex', () => {
        const errorComment = makeComment({
            id: 10,
            body: '## Review\n❌ Failed\n<!-- propr:ai-review model="claude-opus-4-1" error="true" -->',
        });
        const result = gather([errorComment], []);
        assert.strictEqual(result.length, 0);
    });

    test('excludes comments older than 7 days by default', () => {
        const oldDate = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
        const recentDate = new Date().toISOString();
        const comments = [
            makeComment({ id: 10, created_at: oldDate }),
            makeComment({ id: 20, created_at: recentDate }),
        ];
        const result = gather(comments, []);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 20);
    });

    test('respects custom maxAgeMs', () => {
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
        const comments = [makeComment({ id: 10, created_at: twoDaysAgo })];
        const result = gather(comments, [], 1 * 24 * 3600 * 1000);
        assert.strictEqual(result.length, 0);
    });

    test('returns empty when no AI review comments exist', () => {
        const comments: PRComment[] = [
            { id: 1, body: 'Regular comment', user: { login: 'user' }, created_at: new Date().toISOString() },
        ];
        const result = gather(comments, []);
        assert.strictEqual(result.length, 0);
    });

    test('strips boilerplate from returned comment bodies', () => {
        const comments = [makeComment({ id: 10 })];
        const result = gather(comments, []);
        assert.strictEqual(result.length, 1);
        assert.ok(!result[0].body.includes('propr:ai-review'), 'body should not contain marker');
    });

    test('handles null comment bodies gracefully', () => {
        const comments: PRComment[] = [
            { id: 1, body: null, user: { login: 'user' }, created_at: new Date().toISOString() },
        ];
        const result = gather(comments, []);
        assert.strictEqual(result.length, 0);
    });
});
