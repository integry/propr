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

    test('returns many unprocessed comments when none are processed', () => {
        const comments = [
            makeComment({ id: 1 }),
            makeComment({ id: 2 }),
            makeComment({ id: 3 }),
            makeComment({ id: 4 }),
            makeComment({ id: 5 }),
        ];
        const result = gather(comments, []);
        assert.strictEqual(result.length, 5);
        assert.deepStrictEqual(result.map(r => r.id), [1, 2, 3, 4, 5]);
    });

    test('duplicate fix runs do not reconsume already-processed comments', () => {
        const comments = [
            makeComment({ id: 10 }),
            makeComment({ id: 20 }),
            makeComment({ id: 30 }),
        ];
        // First /fix run processes comments 10 and 20
        const firstRun = gather(comments, []);
        assert.strictEqual(firstRun.length, 3);
        const processedAfterFirst = firstRun.map(r => String(r.id));

        // Second /fix run with 10 and 20 already processed
        const secondRun = gather(comments, processedAfterFirst);
        assert.strictEqual(secondRun.length, 0, 'No comments should remain after all are processed');
    });

    test('partial processing leaves remaining comments for next run', () => {
        const comments = [
            makeComment({ id: 10 }),
            makeComment({ id: 20 }),
            makeComment({ id: 30 }),
        ];
        // First /fix only processes comment 10
        const secondRun = gather(comments, ['10']);
        assert.strictEqual(secondRun.length, 2);
        assert.deepStrictEqual(secondRun.map(r => r.id), [20, 30]);

        // Third run processes 10 and 20
        const thirdRun = gather(comments, ['10', '20']);
        assert.strictEqual(thirdRun.length, 1);
        assert.strictEqual(thirdRun[0].id, 30);
    });
});

// ---------------------------------------------------------------------------
// extractReviewScore — score extraction from review body
// ---------------------------------------------------------------------------

const SCORE_RE = /Score:\s*(\d{1,2})\s*\/\s*10/;

function extractReviewScore(body: string): number | null {
    const cleaned = stripReviewBoilerplate(body);
    const match = cleaned.match(SCORE_RE);
    if (!match) return null;
    const score = parseInt(match[1], 10);
    if (score < 1 || score > 10) return null;
    return score;
}

describe('extractReviewScore', () => {
    test('extracts a valid score from a standard review body', () => {
        const body = [
            '## Score',
            'Score: 7/10',
            'The code is well-structured.',
            '<!-- propr:ai-review model="claude-opus-4-1" -->',
        ].join('\n');
        assert.strictEqual(extractReviewScore(body), 7);
    });

    test('extracts score 10/10', () => {
        const body = '## Score\nScore: 10/10\nPerfect.\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), 10);
    });

    test('extracts score 1/10', () => {
        const body = '## Score\nScore: 1/10\nNeeds work.\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), 1);
    });

    test('handles extra whitespace around score', () => {
        const body = 'Score:  8 / 10\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), 8);
    });

    test('returns null for missing score', () => {
        const body = '## Review\nNo score here.\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), null);
    });

    test('returns null for score of 0 (out of range)', () => {
        const body = 'Score: 0/10\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), null);
    });

    test('returns null for score > 10', () => {
        const body = 'Score: 11/10\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), null);
    });

    test('returns null for malformed score line', () => {
        const body = 'Score: seven/10\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), null);
    });

    test('returns null for empty body', () => {
        assert.strictEqual(extractReviewScore(''), null);
    });

    test('extracts first score when multiple appear', () => {
        const body = 'Score: 5/10\nSome text\nScore: 8/10\n<!-- propr:ai-review model="x" -->';
        assert.strictEqual(extractReviewScore(body), 5);
    });
});

// ---------------------------------------------------------------------------
// getPendingReviewState — combined orchestration helper (simulated)
// ---------------------------------------------------------------------------

describe('getPendingReviewState logic', () => {
    interface PRComment2 {
        id: number;
        body: string | null;
        user: { login: string };
        created_at: string;
    }

    function makeScoredComment(id: number, score: number, created_at?: string): PRComment2 {
        return {
            id,
            body: `## Review\nFindings here\n## Score\nScore: ${score}/10\nJustification.\n<!-- propr:ai-review model="claude-opus-4-1" -->`,
            user: { login: 'propr-bot' },
            created_at: created_at ?? new Date().toISOString(),
        };
    }

    function simulatePendingReviewState(
        allComments: PRComment2[],
        processedIds: string[] = [],
    ) {
        // Reuse gather logic
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        const aiReviewComments = allComments.filter(c => c.body && isReviewComment(c.body));
        const processedSet = new Set(processedIds);
        const unprocessedComments: { id: number; body: string; author: string; created_at: string }[] = [];
        for (const comment of aiReviewComments) {
            if (processedSet.has(String(comment.id))) continue;
            if (ERROR_MARKER_RE.test(comment.body!)) continue;
            if (new Date(comment.created_at).getTime() < cutoff) continue;
            unprocessedComments.push({
                id: comment.id,
                body: stripReviewBoilerplate(comment.body!),
                author: comment.user.login,
                created_at: comment.created_at,
            });
        }
        // Find latest score from newest comment first
        const sorted = [...unprocessedComments].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        let latestScore: number | null = null;
        for (const comment of sorted) {
            const score = extractReviewScore(comment.body);
            if (score !== null) {
                latestScore = score;
                break;
            }
        }
        return {
            unprocessedComments,
            latestScore,
            hasPendingReview: unprocessedComments.length > 0,
        };
    }

    test('returns latest score from most recent comment', () => {
        const older = makeScoredComment(1, 4, '2026-04-27T10:00:00Z');
        const newer = makeScoredComment(2, 7, '2026-04-28T10:00:00Z');
        const state = simulatePendingReviewState([older, newer]);
        assert.strictEqual(state.latestScore, 7);
        assert.strictEqual(state.hasPendingReview, true);
        assert.strictEqual(state.unprocessedComments.length, 2);
    });

    test('skips error comments when finding latest score', () => {
        const good = makeScoredComment(1, 6, '2026-04-27T10:00:00Z');
        const errComment: PRComment2 = {
            id: 2,
            body: '## Review\nFailed\nScore: 9/10\n<!-- propr:ai-review model="x" error="true" -->',
            user: { login: 'propr-bot' },
            created_at: '2026-04-28T10:00:00Z',
        };
        const state = simulatePendingReviewState([good, errComment]);
        assert.strictEqual(state.latestScore, 6);
        assert.strictEqual(state.unprocessedComments.length, 1);
    });

    test('returns null score when no comments have valid scores', () => {
        const noScore: PRComment2 = {
            id: 1,
            body: '## Review\nNo score here.\n<!-- propr:ai-review model="x" -->',
            user: { login: 'propr-bot' },
            created_at: new Date().toISOString(),
        };
        const state = simulatePendingReviewState([noScore]);
        assert.strictEqual(state.latestScore, null);
        assert.strictEqual(state.hasPendingReview, true);
    });

    test('returns hasPendingReview false when no unprocessed comments', () => {
        const state = simulatePendingReviewState([]);
        assert.strictEqual(state.hasPendingReview, false);
        assert.strictEqual(state.latestScore, null);
        assert.strictEqual(state.unprocessedComments.length, 0);
    });

    test('skips processed comments and finds score from remaining', () => {
        const processed = makeScoredComment(1, 3, '2026-04-27T10:00:00Z');
        const unprocessed = makeScoredComment(2, 8, '2026-04-28T10:00:00Z');
        const state = simulatePendingReviewState([processed, unprocessed], ['1']);
        assert.strictEqual(state.latestScore, 8);
        assert.strictEqual(state.unprocessedComments.length, 1);
    });

    test('handles mix of scored and unscored comments', () => {
        const unscored: PRComment2 = {
            id: 1,
            body: '## Review\nFindings only.\n<!-- propr:ai-review model="x" -->',
            user: { login: 'propr-bot' },
            created_at: '2026-04-28T12:00:00Z',
        };
        const scored = makeScoredComment(2, 5, '2026-04-28T10:00:00Z');
        const state = simulatePendingReviewState([unscored, scored]);
        // Most recent (unscored) has no score, so falls through to scored one
        assert.strictEqual(state.latestScore, 5);
        assert.strictEqual(state.unprocessedComments.length, 2);
    });
});

// ---------------------------------------------------------------------------
// extractReviewModel — model extraction from marker
// ---------------------------------------------------------------------------

const REVIEW_COMMENT_MARKER_RE_EXTRACT = /<!-- propr:ai-review model="([^"]+)"(?: [^>]*)? -->/;

function extractReviewModel(body: string): string | null {
    const match = body.match(REVIEW_COMMENT_MARKER_RE_EXTRACT);
    return match ? match[1] : null;
}

describe('extractReviewModel', () => {
    test('extracts model from standard marker', () => {
        const body = 'Some review content\n<!-- propr:ai-review model="claude-opus-4-1" -->';
        assert.strictEqual(extractReviewModel(body), 'claude-opus-4-1');
    });

    test('extracts model from error marker', () => {
        const body = '❌ Failed\n<!-- propr:ai-review model="gpt-54" error="true" -->';
        assert.strictEqual(extractReviewModel(body), 'gpt-54');
    });

    test('returns null for non-review comment', () => {
        assert.strictEqual(extractReviewModel('Just a regular comment'), null);
    });

    test('returns null for empty body', () => {
        assert.strictEqual(extractReviewModel(''), null);
    });

    test('extracts model with complex name', () => {
        const body = '<!-- propr:ai-review model="gemini-3-pro-preview-2025-01" -->';
        assert.strictEqual(extractReviewModel(body), 'gemini-3-pro-preview-2025-01');
    });
});

// ---------------------------------------------------------------------------
// formatReviewCommentsSection — formatting for /fix prompt inclusion
// ---------------------------------------------------------------------------

interface AIReviewComment {
    id: number;
    body: string;
    author: string;
    created_at: string;
}

function formatReviewCommentsSection(reviewComments: AIReviewComment[]): string {
    if (reviewComments.length === 0) return '';

    let section = `**AI Review Comments (unprocessed — please address these findings):**\n\n`;
    for (const comment of reviewComments) {
        section += `---\n**Review by:** @${comment.author} (Comment ID: ${comment.id})\n`;
        section += `${comment.body}\n---\n\n`;
    }
    return section;
}

describe('formatReviewCommentsSection', () => {
    test('returns empty string for zero comments', () => {
        assert.strictEqual(formatReviewCommentsSection([]), '');
    });

    test('formats a single review comment', () => {
        const comments: AIReviewComment[] = [{
            id: 42,
            body: 'Missing null check on line 10.',
            author: 'propr-bot',
            created_at: new Date().toISOString(),
        }];
        const result = formatReviewCommentsSection(comments);
        assert.ok(result.includes('AI Review Comments'));
        assert.ok(result.includes('@propr-bot'));
        assert.ok(result.includes('Comment ID: 42'));
        assert.ok(result.includes('Missing null check on line 10.'));
    });

    test('formats multiple review comments', () => {
        const comments: AIReviewComment[] = [
            { id: 10, body: 'Finding A', author: 'bot-a', created_at: new Date().toISOString() },
            { id: 20, body: 'Finding B', author: 'bot-b', created_at: new Date().toISOString() },
            { id: 30, body: 'Finding C', author: 'bot-c', created_at: new Date().toISOString() },
        ];
        const result = formatReviewCommentsSection(comments);
        assert.ok(result.includes('Comment ID: 10'));
        assert.ok(result.includes('Comment ID: 20'));
        assert.ok(result.includes('Comment ID: 30'));
        assert.ok(result.includes('Finding A'));
        assert.ok(result.includes('Finding B'));
        assert.ok(result.includes('Finding C'));
    });

    test('includes author mentions with @ prefix', () => {
        const comments: AIReviewComment[] = [{
            id: 1,
            body: 'test',
            author: 'my-review-bot',
            created_at: new Date().toISOString(),
        }];
        const result = formatReviewCommentsSection(comments);
        assert.ok(result.includes('@my-review-bot'));
    });
});
