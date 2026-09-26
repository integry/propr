import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { parseFixSelection } from '../src/jobs/reviewFindingSelector.js';

after(async () => {
    await closeConnection();
});

describe('/fix command-line selection', () => {
    const cases: Array<[string, string, { findingIds: string[]; suggestionIds: string[]; instructions: string; malformedIds: string[] }]> = [
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
    ];

    for (const [description, input, expected] of cases) {
        test(description, () => assert.deepStrictEqual(parseFixSelection(input), expected));
    }

    test('treats a missing command body as a bare /fix', () => {
        assert.deepStrictEqual(parseFixSelection(undefined), { findingIds: [], suggestionIds: [], instructions: '', malformedIds: [] });
    });
});
