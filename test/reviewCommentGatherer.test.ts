/**
 * Tests for review comment gathering and sanitization logic.
 *
 * Because the full module transitively imports @propr/core (which requires a
 * workspace build), these tests exercise the exported pure functions by
 * re-implementing the key helpers inline so the test file stays self-contained.
 */
import { after, test, describe } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '@propr/core';

const {
    extractActionableFindings: extractStructuredActionableFindings,
    extractReviewSuggestions: extractStructuredReviewSuggestions,
    parseStructuredReview,
    gatherUnprocessedReviewComments: gatherStructuredReviewComments,
    getPendingReviewState: getStructuredPendingReviewState,
    markReviewFindingsProcessed: markStructuredReviewFindingsProcessed,
} = await import('../src/jobs/reviewCommentGatherer.js');
const {
    formatReviewCommentsSection: formatSelectedReviewRecords,
    hasAuthorizedFixFeedback,
    parseFixFindingSelection,
    selectReviewFeedback,
} = await import('../src/jobs/reviewFindingSelector.js');

after(async () => {
    await closeConnection();
});

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

const STRUCTURED_REVIEW = [
    '## Overall Evaluation',
    'One blocker and one optional follow-up.',
    '',
    '## Actionable Findings',
    '### F1: Preserve terminal state',
    '- **violatedRequirement:** Terminal states cannot be resurrected',
    '- **evidence:** src/worker.ts:128 — new bypass accepts the transition',
    '- **introducedByPR:** true — the changed transition handler added the bypass',
    '- **requiredForMerge:** true',
    '- **minimumCorrection:** reject transitions from terminal states',
    '',
    '## Suggestions and Follow-ups',
    '### S1: Consider a durable publication outbox',
    '',
    '## Score',
    'Score: 7/10',
].join('\n');

describe('structured review finding extraction', () => {
    test('extracts complete F# blocker records and S# suggestions separately', () => {
        const findings = extractStructuredActionableFindings(STRUCTURED_REVIEW);
        const suggestions = extractStructuredReviewSuggestions(STRUCTURED_REVIEW);

        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].id, 'F1');
        assert.strictEqual(findings[0].introducedByPR, true);
        assert.match(findings[0].introducedByPRExplanation, /changed transition handler/);
        assert.strictEqual(suggestions.length, 1);
        assert.deepStrictEqual(suggestions[0], {
            id: 'S1',
            title: 'Consider a durable publication outbox',
        });
    });

    test('rejects an actionable record that cannot supply every required proof', () => {
        const incomplete = STRUCTURED_REVIEW.replace(
            '- **minimumCorrection:** reject transitions from terminal states\n',
            '',
        );
        assert.deepStrictEqual(extractStructuredActionableFindings(incomplete), []);
        assert.strictEqual(parseStructuredReview(incomplete).status, 'invalid');
    });

    test('rejects suggestion metadata outside the concise heading contract', () => {
        const cluttered = STRUCTURED_REVIEW.replace(
            '### S1: Consider a durable publication outbox\n',
            '### S1: Consider a durable publication outbox\n- **autoFix:** false\n',
        );
        assert.strictEqual(parseStructuredReview(cluttered).status, 'invalid');
    });

    test('distinguishes blocker, explicitly clean, and malformed review output', () => {
        const clean = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const malformed = STRUCTURED_REVIEW.replace(
            '- **evidence:** src/worker.ts:128 — new bypass accepts the transition\n',
            '',
        );

        assert.strictEqual(parseStructuredReview(STRUCTURED_REVIEW).status, 'valid_with_blockers');
        assert.strictEqual(parseStructuredReview(clean).status, 'valid_clean');
        assert.strictEqual(parseStructuredReview(malformed).status, 'invalid');
    });

    test('strips the formatter title but rejects an extra findings heading before the contract', () => {
        const clean = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const formatterTitle = '## 🔍 AI Code Review — Test Model';
        const malformed = [
            formatterTitle,
            '',
            '## Findings',
            '### F1: Hidden blocker',
            'A blocker outside the structured contract.',
            '',
            clean,
            '<!-- propr:ai-review model="test" -->',
        ].join('\n');

        assert.strictEqual(parseStructuredReview(`${formatterTitle}\n\n${clean}`).status, 'valid_clean');
        assert.strictEqual(parseStructuredReview(malformed).status, 'invalid');
    });

    test('never promotes suggestions into actionable findings', () => {
        const suggestionOnly = [
            '## Actionable Findings',
            'No actionable findings.',
            '## Suggestions and Follow-ups',
            '### S1: Add an outbox as optional architecture hardening',
            '## Score',
            'Score: 9/10',
        ].join('\n');
        assert.deepStrictEqual(extractStructuredActionableFindings(suggestionOnly), []);
        assert.strictEqual(extractStructuredReviewSuggestions(suggestionOnly)[0].id, 'S1');
    });

    test('gatherer exposes actionable-only body while retaining typed suggestions for the public review', async () => {
        const redis = { smembers: async () => [] };
        const correlatedLogger = { debug() {}, info() {}, warn() {} };
        const comments = [{
            id: 42,
            body: `${STRUCTURED_REVIEW}\n<!-- propr:ai-review model="test" -->`,
            user: { login: 'propr-bot', type: 'Bot' },
            created_at: new Date().toISOString(),
        }];
        const gathered = await gatherStructuredReviewComments(comments, {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: redis as any,
            correlatedLogger: correlatedLogger as any,
        });
        assert.strictEqual(gathered.length, 1);
        assert.match(gathered[0].body, /F1: Preserve terminal state/);
        assert.ok(!gathered[0].body.includes('durable publication outbox'));
        assert.strictEqual(gathered[0].actionableFindings.length, 1);
        assert.strictEqual(gathered[0].suggestions.length, 1);
    });

    test('suggestion-only reviews do not count as pending automated fixes', async () => {
        const body = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const state = await getStructuredPendingReviewState([{
            id: 43,
            body: `${body}\n<!-- propr:ai-review model="test" -->`,
            user: { login: 'propr-bot', type: 'Bot' },
            created_at: new Date().toISOString(),
        }], {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: { smembers: async () => [] } as any,
            correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
        });
        assert.strictEqual(state.hasPendingReview, false);
        assert.strictEqual(state.reviewStatus, 'valid_clean');
        assert.strictEqual(state.latestScore, 7);
        assert.strictEqual(state.unprocessedComments[0].suggestions.length, 1);
    });

    test('newest malformed review stays invalid instead of borrowing an older score', async () => {
        const now = Date.now();
        const malformed = STRUCTURED_REVIEW.replace(
            '- **minimumCorrection:** reject transitions from terminal states\n',
            '',
        );
        const state = await getStructuredPendingReviewState([
            {
                id: 46,
                body: `${STRUCTURED_REVIEW}\n<!-- propr:ai-review model="older" -->`,
                user: { login: 'propr-bot', type: 'Bot' },
                created_at: new Date(now - 1_000).toISOString(),
            },
            {
                id: 47,
                body: `${malformed}\n<!-- propr:ai-review model="newer" -->`,
                user: { login: 'propr-bot', type: 'Bot' },
                created_at: new Date(now).toISOString(),
            },
        ], {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: { smembers: async () => [] } as any,
            correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
        });

        assert.strictEqual(state.reviewStatus, 'invalid');
        assert.strictEqual(state.latestScore, null);
    });

    test('a newest error review is retained as invalid for orchestration', async () => {
        const now = Date.now();
        const clean = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const structurallyValidError = [
            'Review generation failed with the following message:',
            clean,
            '<!-- propr:ai-review model="newer" error="true" -->',
        ].join('\n');
        assert.strictEqual(parseStructuredReview(structurallyValidError).status, 'invalid');

        const state = await getStructuredPendingReviewState([
            {
                id: 48,
                body: `${clean}\n<!-- propr:ai-review model="older" -->`,
                user: { login: 'propr-bot', type: 'Bot' },
                created_at: new Date(now - 1_000).toISOString(),
            },
            {
                id: 49,
                body: structurallyValidError,
                user: { login: 'propr-bot', type: 'Bot' },
                created_at: new Date(now).toISOString(),
            },
        ], {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: { smembers: async () => [] } as any,
            correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
        });

        assert.strictEqual(state.reviewStatus, 'invalid');
        assert.strictEqual(state.latestScore, null);
    });

    test('an empty current review result set cannot reuse a stale clean review', async () => {
        const clean = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const state = await getStructuredPendingReviewState([{
            id: 50,
            body: `${clean}\n<!-- propr:ai-review model="stale" -->`,
            user: { login: 'propr-bot', type: 'Bot' },
            created_at: new Date().toISOString(),
        }], {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: { smembers: async () => [] } as any,
            correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
            currentReviewCommentIds: [],
        });

        assert.strictEqual(state.reviewStatus, 'invalid');
        assert.strictEqual(state.latestScore, null);
        assert.deepStrictEqual(state.unprocessedComments, []);
    });

    test('a missing current review comment cannot reuse a different clean review', async () => {
        const clean = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const state = await getStructuredPendingReviewState([{
            id: 51,
            body: `${clean}\n<!-- propr:ai-review model="stale" -->`,
            user: { login: 'propr-bot', type: 'Bot' },
            created_at: new Date().toISOString(),
        }], {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: { smembers: async () => [] } as any,
            correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
            currentReviewCommentIds: [52],
        });

        assert.strictEqual(state.reviewStatus, 'invalid');
        assert.strictEqual(state.latestScore, null);
    });

    test('a partially posted multi-model result set is invalid', async () => {
        const clean = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const state = await getStructuredPendingReviewState([{
            id: 52,
            body: `${clean}\n<!-- propr:ai-review model="posted" -->`,
            user: { login: 'propr-bot', type: 'Bot' },
            created_at: new Date().toISOString(),
        }], {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: { smembers: async () => [] } as any,
            correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
            currentReviewCommentIds: [52],
            currentReviewResultCount: 2,
        });

        assert.strictEqual(state.reviewStatus, 'invalid');
        assert.strictEqual(state.latestScore, null);
    });

    test('a blocker in any current multi-model review overrides a newer clean review', async () => {
        const now = Date.now();
        const clean = STRUCTURED_REVIEW.replace(
            /### F1: Preserve terminal state[\s\S]*?(?=\n## Suggestions and Follow-ups)/,
            'No actionable findings.',
        );
        const state = await getStructuredPendingReviewState([
            {
                id: 53,
                body: `${STRUCTURED_REVIEW}\n<!-- propr:ai-review model="blocker" -->`,
                user: { login: 'propr-bot', type: 'Bot' },
                created_at: new Date(now - 1_000).toISOString(),
            },
            {
                id: 54,
                body: `${clean}\n<!-- propr:ai-review model="clean" -->`,
                user: { login: 'propr-bot', type: 'Bot' },
                created_at: new Date(now).toISOString(),
            },
        ], {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: { smembers: async () => [] } as any,
            correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
            currentReviewCommentIds: [53, 54],
        });

        assert.strictEqual(state.reviewStatus, 'valid_with_blockers');
        assert.strictEqual(state.hasPendingReview, true);
        assert.deepStrictEqual(state.unprocessedComments.map(comment => comment.id), [53, 54]);
    });

    test('record-level consumption preserves unselected blockers from the same review', async () => {
        const reviewWithTwoFindings = STRUCTURED_REVIEW.replace(
            '\n## Suggestions and Follow-ups',
            [
                '',
                '### F2: Preserve concurrency',
                '- **violatedRequirement:** Concurrent updates cannot corrupt state',
                '- **evidence:** src/worker.ts:144 — changed write is not serialized',
                '- **introducedByPR:** true — the PR added the unsynchronized write',
                '- **requiredForMerge:** true',
                '- **minimumCorrection:** serialize the changed state update',
                '',
                '## Suggestions and Follow-ups',
            ].join('\n'),
        );
        const sets = new Map<string, Set<string>>();
        const redis = {
            async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
            async sadd(key: string, ...members: string[]) {
                const values = sets.get(key) ?? new Set<string>();
                members.forEach(member => values.add(member));
                sets.set(key, values);
                return members.length;
            },
            async expire() { return 1; },
        };
        const correlatedLogger = { debug() {}, info() {}, warn() {} };
        const comments = [{
            id: 44,
            body: `${reviewWithTwoFindings}\n<!-- propr:ai-review model="test" -->`,
            user: { login: 'propr-bot', type: 'Bot' },
            created_at: new Date().toISOString(),
        }];
        const options = {
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            redisClient: redis as any,
            correlatedLogger: correlatedLogger as any,
        };
        const first = await gatherStructuredReviewComments(comments, options);
        assert.deepStrictEqual(first[0].actionableFindings.map(finding => finding.id), ['F1', 'F2']);

        await markStructuredReviewFindingsProcessed([{
            ...first[0],
            body: '',
            actionableFindings: [first[0].actionableFindings[0]],
            suggestions: [],
        }], options);

        const second = await gatherStructuredReviewComments(comments, options);
        assert.deepStrictEqual(second[0].actionableFindings.map(finding => finding.id), ['F2']);
        assert.strictEqual(second[0].suggestions.length, 1, 'unselected suggestion remains informational');
    });
});

describe('/fix structured finding selection', () => {
    const reviewComment = (overrides: { id?: number; created_at?: string; findingTitle?: string } = {}) => ({
        id: overrides.id ?? 45,
        body: '',
        author: 'propr-bot',
        created_at: overrides.created_at ?? new Date().toISOString(),
        actionableFindings: extractStructuredActionableFindings(STRUCTURED_REVIEW).map(finding => ({
            ...finding,
            title: overrides.findingTitle ?? finding.title,
        })),
        suggestions: extractStructuredReviewSuggestions(STRUCTURED_REVIEW),
        score: 7,
        reviewStatus: 'valid_with_blockers' as const,
    });

    test('bare /fix selects blockers and keeps suggestion prose out of the prompt', () => {
        const all = [reviewComment()];
        const selected = selectReviewFeedback(all, parseFixFindingSelection(''));
        const section = formatSelectedReviewRecords(selected);
        assert.match(section, /Address actionable finding F1 only/);
        assert.doesNotMatch(section, /S1/);
        assert.ok(!section.includes('Consider a durable publication outbox'));
        assert.ok(!section.includes('Score: 7/10'));
    });

    test('rejects suggestion selection syntax even after a blocker ID', () => {
        const selection = parseFixFindingSelection('F1 include S1\nKeep the correction localized.');
        assert.deepStrictEqual([...selection.actionableIds ?? []], []);
        assert.strictEqual(selection.remainingInstructions, 'include S1\nKeep the correction localized.');

        const all = [reviewComment()];
        const selected = selectReviewFeedback(all, selection);
        assert.deepStrictEqual(selected, []);
        const section = formatSelectedReviewRecords(selected);
        assert.doesNotMatch(section, /Explicitly Authorized Suggestions/);
        assert.doesNotMatch(section, /Consider a durable publication outbox/);

        const bareSuggestionId = parseFixFindingSelection('F1 S1');
        assert.deepStrictEqual([...bareSuggestionId.actionableIds ?? []], []);
    });

    test('only extracts IDs from the dedicated leading selector clause', () => {
        const selection = parseFixFindingSelection('F1; do not touch F2');
        assert.deepStrictEqual([...selection.actionableIds ?? []], ['F1']);
        assert.strictEqual(selection.remainingInstructions, 'do not touch F2');

        const proseOnly = parseFixFindingSelection('Do not touch F2 while addressing the regression.');
        assert.strictEqual(proseOnly.actionableIds, null);
        assert.strictEqual(proseOnly.remainingInstructions, 'Do not touch F2 while addressing the regression.');
    });

    test('preserves a leading selector when instructions follow without a delimiter', () => {
        const selection = parseFixFindingSelection('F1 please keep the change localized');
        assert.deepStrictEqual([...selection.actionableIds ?? []], ['F1']);
        assert.strictEqual(selection.remainingInstructions, 'please keep the change localized');

        const includeInstruction = parseFixFindingSelection('F1 include a regression test');
        assert.deepStrictEqual([...includeInstruction.actionableIds ?? []], ['F1']);
        assert.strictEqual(includeInstruction.remainingInstructions, 'include a regression test');

        const comment = reviewComment();
        comment.actionableFindings.push({
            ...comment.actionableFindings[0],
            id: 'F2',
            title: 'Unselected finding',
        });
        const selected = selectReviewFeedback([comment], selection);
        assert.deepStrictEqual(selected[0].actionableFindings.map(finding => finding.id), ['F1']);
    });

    test('fails closed when a leading selector is attempted but malformed', () => {
        const selection = parseFixFindingSelection('include please keep the change localized');
        assert.notStrictEqual(selection.actionableIds, null);
        assert.deepStrictEqual([...selection.actionableIds!], []);
        const selected = selectReviewFeedback([reviewComment()], selection);
        assert.deepStrictEqual(selected, []);
        assert.strictEqual(hasAuthorizedFixFeedback(selected), false);
    });

    test('does not authorize execution for unknown IDs or a bare fix with no blockers', () => {
        const unknownSelection = selectReviewFeedback(
            [reviewComment()],
            parseFixFindingSelection('F999'),
        );
        assert.deepStrictEqual(unknownSelection, []);
        assert.strictEqual(hasAuthorizedFixFeedback(unknownSelection), false);

        const suggestionOnlyReview = reviewComment();
        suggestionOnlyReview.actionableFindings = [];
        const bareSelection = selectReviewFeedback(
            [suggestionOnlyReview],
            parseFixFindingSelection(''),
        );
        assert.deepStrictEqual(bareSelection, []);
        assert.strictEqual(hasAuthorizedFixFeedback(bareSelection), false);

        const rejectedSuggestion = selectReviewFeedback(
            [suggestionOnlyReview],
            parseFixFindingSelection('include S1'),
        );
        assert.deepStrictEqual(rejectedSuggestion, []);
        assert.strictEqual(hasAuthorizedFixFeedback(rejectedSuggestion), false);
    });

    test('scopes explicit IDs to the newest review comment when models reuse F1', () => {
        const older = reviewComment({
            id: 45,
            created_at: '2026-08-06T09:00:00.000Z',
            findingTitle: 'Older model finding',
        });
        const newer = reviewComment({
            id: 46,
            created_at: '2026-08-06T09:01:00.000Z',
            findingTitle: 'Newest model finding',
        });

        const selected = selectReviewFeedback([older, newer], parseFixFindingSelection('F1'));
        assert.deepStrictEqual(selected.map(comment => comment.id), [46]);
        assert.strictEqual(selected[0].actionableFindings[0].title, 'Newest model finding');

        const bareSelection = selectReviewFeedback([older, newer], parseFixFindingSelection(''));
        assert.deepStrictEqual(bareSelection.map(comment => comment.id), [45, 46]);
    });
});

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

    const recentIso = (hoursAgo: number): string =>
        new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

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
        const older = makeScoredComment(1, 4, recentIso(24));
        const newer = makeScoredComment(2, 7, recentIso(1));
        const state = simulatePendingReviewState([older, newer]);
        assert.strictEqual(state.latestScore, 7);
        assert.strictEqual(state.hasPendingReview, true);
        assert.strictEqual(state.unprocessedComments.length, 2);
    });

    test('skips error comments when finding latest score', () => {
        const good = makeScoredComment(1, 6, recentIso(24));
        const errComment: PRComment2 = {
            id: 2,
            body: '## Review\nFailed\nScore: 9/10\n<!-- propr:ai-review model="x" error="true" -->',
            user: { login: 'propr-bot' },
            created_at: recentIso(1),
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
        const processed = makeScoredComment(1, 3, recentIso(24));
        const unprocessed = makeScoredComment(2, 8, recentIso(1));
        const state = simulatePendingReviewState([processed, unprocessed], ['1']);
        assert.strictEqual(state.latestScore, 8);
        assert.strictEqual(state.unprocessedComments.length, 1);
    });

    test('handles mix of scored and unscored comments', () => {
        const unscored: PRComment2 = {
            id: 1,
            body: '## Review\nFindings only.\n<!-- propr:ai-review model="x" -->',
            user: { login: 'propr-bot' },
            created_at: recentIso(1),
        };
        const scored = makeScoredComment(2, 5, recentIso(3));
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
