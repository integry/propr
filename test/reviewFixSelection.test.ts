import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { buildCommandMeta, closeConnection, parseSlashCommand } from '@propr/core';
import { type FixSelection, parseFixCommand, parseFixSelection, resolveReviewFeedback } from '../src/jobs/reviewFindingSelector.js';

after(async () => {
    await closeConnection();
});

describe('/fix command-line selection', () => {
    const cases: Array<[string, string, FixSelection]> = [
        ['selects all pending feedback', 'all',
            { selectAll: true, findingIds: [], suggestionIds: [], instructions: '', malformedIds: [] }],
        ['accepts uppercase ALL', 'ALL',
            { selectAll: true, findingIds: [], suggestionIds: [], instructions: '', malformedIds: [] }],
        ['accepts trailing commas and whitespace after all', '  all , ',
            { selectAll: true, findingIds: [], suggestionIds: [], instructions: '', malformedIds: [] }],
        ['keeps inline instructions after all', 'all; keep it',
            { selectAll: true, findingIds: [], suggestionIds: [], instructions: 'keep it', malformedIds: [] }],
        ['keeps following lines after all as prose', 'all\nbelow',
            { selectAll: true, findingIds: [], suggestionIds: [], instructions: 'below', malformedIds: [] }],
        ['combines inline and following instructions after all', 'all , ; keep it\r\n\r\nS3 is prose.\r\nMore.',
            { selectAll: true, findingIds: [], suggestionIds: [], instructions: 'keep it\n\nS3 is prose.\nMore.', malformedIds: [] }],
        ['keeps all in ordinary instructions', 'all the failing tests',
            { findingIds: [], suggestionIds: [], instructions: 'all the failing tests', malformedIds: [] }],
        ['refuses all combined with a finding selector', 'all F3',
            { findingIds: [], suggestionIds: [], instructions: '', malformedIds: ['ALL F3'] }],
        ['refuses all combined with a suggestion selector', 'all S3',
            { findingIds: [], suggestionIds: [], instructions: '', malformedIds: ['ALL S3'] }],
        ['refuses all combined with a malformed selector', 'all S0',
            { findingIds: [], suggestionIds: [], instructions: '', malformedIds: ['ALL S0'] }],
        ['refuses mixed selectors even with trailing context', 'ALL, f3 s3; keep it small\nMore context.',
            { findingIds: [], suggestionIds: [], instructions: '', malformedIds: ['ALL, F3 S3'] }],
        ['does not interpret all below the command as a shorthand', '\nall',
            { findingIds: [], suggestionIds: [], instructions: 'all', malformedIds: [] }],
        ['mixes both namespaces in any order', 'F20 S3 S5',
            { findingIds: ['F20'], suggestionIds: ['S3', 'S5'], instructions: '', malformedIds: [] }],
        ['accepts suggestions on their own', 'S3',
            { findingIds: [], suggestionIds: ['S3'], instructions: '', malformedIds: [] }],
        ['keeps order-independent selection', 'S5 F1 F2',
            { findingIds: ['F1', 'F2'], suggestionIds: ['S5'], instructions: '', malformedIds: [] }],
        // Canonical casing: the receipt, the posted comment and the prompt must
        // never disagree with the published `F20`.
        ['normalises case', 'f20 s3',
            { findingIds: ['F20'], suggestionIds: ['S3'], instructions: '', malformedIds: [] }],
        ['de-duplicates', 'F20 F20 S3 s3',
            { findingIds: ['F20'], suggestionIds: ['S3'], instructions: '', malformedIds: [] }],
        ['accepts comma-separated selectors', 'F1, F2, S3',
            { findingIds: ['F1', 'F2'], suggestionIds: ['S3'], instructions: '', malformedIds: [] }],
        // The free-text half: following lines are prose by construction.
        ['treats following lines as instructions', 'F20 S3\n\nAlso rename the helper.',
            { findingIds: ['F20'], suggestionIds: ['S3'], instructions: 'Also rename the helper.', malformedIds: [] }],
        ['stops at the first prose token on the command line', 'F20 keep the public API stable',
            { findingIds: ['F20'], suggestionIds: [], instructions: 'keep the public API stable', malformedIds: [] }],
        ['still honours a semicolon selector terminator', 'F20; do not touch F2',
            { findingIds: ['F20'], suggestionIds: [], instructions: 'do not touch F2', malformedIds: [] }],
        // Reported, not reclassified: a typo must not become an empty request.
        ['reports selector-shaped typos', 'F20 S0 please hurry',
            { findingIds: ['F20'], suggestionIds: [], instructions: 'please hurry', malformedIds: ['S0'] }],
        ['reports zero-padded and negative selectors', 'F007 F-1 S3',
            { findingIds: [], suggestionIds: ['S3'], instructions: '', malformedIds: ['F007', 'F-1'] }],
        // Prose that merely starts with a letter and digits is still prose.
        ['does not misread ordinary prose', 'Fix 2 callers of the helper',
            { findingIds: [], suggestionIds: [], instructions: 'Fix 2 callers of the helper', malformedIds: [] }],
        ['preserves the free-text-only form', 'Please add a regression test.',
            { findingIds: [], suggestionIds: [], instructions: 'Please add a regression test.', malformedIds: [] }],
        ['handles an empty command', '',
            { findingIds: [], suggestionIds: [], instructions: '', malformedIds: [] }],
        // A CRLF body from the GitHub web UI must parse identically to an LF one.
        ['normalises CRLF', 'F20\r\n\r\nKeep the lock.',
            { findingIds: ['F20'], suggestionIds: [], instructions: 'Keep the lock.', malformedIds: [] }],
        // Identifiers are read from the command line only, so prose below it is
        // never eaten as a selector.
        ['never reads selectors from a following line', 'Rework the retry\nS3 is already done',
            { findingIds: [], suggestionIds: [], instructions: 'Rework the retry\nS3 is already done', malformedIds: [] }],
        ['keeps interior blank lines in the instructions', 'F1\n\nFirst point.\n\nSecond point.',
            { findingIds: ['F1'], suggestionIds: [], instructions: 'First point.\n\nSecond point.', malformedIds: [] }],
        // Unsupported selector shapes are refused, not reclassified as prose: a
        // rejected attempt must never fall through to the bare `/fix` meaning of
        // every pending blocker.
        ['refuses an unsupported range selector', 'F1-F2',
            { findingIds: [], suggestionIds: [], instructions: '', malformedIds: ['F1-F2'] }],
        ['refuses a selector with trailing garbage', 'F1x keep it small',
            { findingIds: [], suggestionIds: [], instructions: 'keep it small', malformedIds: ['F1X'] }],
        ['refuses a range beside a valid identifier', 'F1 S3-S5',
            { findingIds: ['F1'], suggestionIds: [], instructions: '', malformedIds: ['S3-S5'] }],
        // Prose is still prose: a token only counts as an attempted selector when
        // it starts with F/S immediately followed by a digit.
        ['keeps prose that merely mentions a range', 'Rework retries in F1 and F2 style',
            { findingIds: [], suggestionIds: [], instructions: 'Rework retries in F1 and F2 style', malformedIds: [] }],
    ];

    for (const [description, input, expected] of cases) {
        test(description, () => assert.deepStrictEqual(parseFixSelection(input), expected));
    }

    test('treats a missing command body as a bare /fix', () => {
        assert.deepStrictEqual(parseFixSelection(undefined), { findingIds: [], suggestionIds: [], instructions: '', malformedIds: [] });
    });
});

describe('/fix intake preserves the command-line boundary', () => {
    /** The real producer-to-worker path: comment body → command meta → selection. */
    const selectionFor = (body: string) => {
        const meta = buildCommandMeta(parseSlashCommand(body)!);
        assert.strictEqual(meta.mode, 'fix');
        const fix = meta as { commandLine?: string; bodyInstructions?: string };
        return parseFixCommand({ commandLine: fix.commandLine, bodyInstructions: fix.bodyInstructions });
    };

    for (const body of ['/fix all\nS3 is prose; keep the API stable.', '/fix all; S3 is prose; keep the API stable.']) {
        test(`preserves all selection and context through intake: ${JSON.stringify(body)}`, () => {
            assert.deepStrictEqual(selectionFor(body), {
                selectAll: true, findingIds: [], suggestionIds: [], malformedIds: [],
                instructions: 'S3 is prose; keep the API stable.',
            });
        });
    }

    test('all combined with a selector fails closed through intake', () => {
        const selection = selectionFor('/fix all S3');
        assert.deepStrictEqual(selection.malformedIds, ['ALL S3']);
        const resolution = resolveReviewFeedback([], selection);
        assert.deepStrictEqual(resolution.selected, { findingIds: [], suggestionIds: [] });
        assert.deepStrictEqual(resolution.malformedIds, ['ALL S3']);
    });

    test('a bare /fix whose instructions begin with an identifier selects nothing', () => {
        const selection = selectionFor('/fix\nS3 is already done; keep the blocker correction localized.');
        assert.deepStrictEqual(selection.findingIds, []);
        assert.deepStrictEqual(selection.suggestionIds, []);
        assert.deepStrictEqual(selection.malformedIds, []);
        // The prose reaches the agent intact, semicolon and identifier included.
        assert.strictEqual(selection.instructions, 'S3 is already done; keep the blocker correction localized.');
    });

    test('identifiers on the command line still select, with the prose below preserved', () => {
        const selection = selectionFor('/fix F20 S3 keep the API stable\n\nS5 is out of scope.');
        assert.deepStrictEqual(selection.findingIds, ['F20']);
        assert.deepStrictEqual(selection.suggestionIds, ['S3']);
        // Intake trims the body, so the blank line between the two halves is
        // already gone by the time the selector parser sees them.
        assert.strictEqual(selection.instructions, 'keep the API stable\nS5 is out of scope.');
    });

    test('a /fix with only instruction lines never widens to every blocker either', () => {
        const review = {
            id: 7,
            body: '',
            author: 'propr-bot',
            created_at: new Date().toISOString(),
            actionableFindings: ['F1', 'F2'].map(id => ({
                id,
                title: `Blocker ${id}`,
                violatedRequirement: '',
                evidence: '',
                introducedByPR: true as const,
                introducedByPRExplanation: '',
                requiredForMerge: true as const,
                minimumCorrection: '',
            })),
            suggestions: [{ id: 'S3', title: 'Optional follow-up', description: '' }],
            score: 7,
            reviewStatus: 'valid_with_blockers' as const,
            isPartial: false,
        };
        // No identifiers were named, so the bare meaning applies: both blockers,
        // and never the suggestion the instruction prose mentions.
        const resolution = resolveReviewFeedback([review], selectionFor('/fix\nS3 is already done; keep the blocker correction localized.'));
        assert.deepStrictEqual(resolution.selected, { findingIds: ['F1', 'F2'], suggestionIds: [] });
        assert.deepStrictEqual(resolution.comments[0].suggestions, []);
    });
});
