import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalizeReviewFeedbackSelection,
  describeReviewFeedbackSelection,
  formatReviewFeedbackSelection,
  isEmptyReviewFeedbackSelection,
  isMalformedReviewFeedbackToken,
  normalizeReviewFeedbackId,
  REVIEW_FINDING_ID_PATTERN,
  REVIEW_SUGGESTION_ID_PATTERN,
} from '../src/reviewFeedbackIds.js';

test('identifiers are recognised per namespace and canonicalised to upper case', () => {
  assert.deepEqual(normalizeReviewFeedbackId('f20'), { kind: 'finding', id: 'F20' });
  assert.deepEqual(normalizeReviewFeedbackId(' s3 '), { kind: 'suggestion', id: 'S3' });
  assert.equal(normalizeReviewFeedbackId('F0'), null);
  assert.equal(normalizeReviewFeedbackId('F007'), null);
  assert.equal(normalizeReviewFeedbackId('Fix'), null);
  // Both surfaces validate through the same patterns, so neither can drift.
  assert.ok(REVIEW_FINDING_ID_PATTERN.test('f1') && !REVIEW_FINDING_ID_PATTERN.test('S1'));
  assert.ok(REVIEW_SUGGESTION_ID_PATTERN.test('S12') && !REVIEW_SUGGESTION_ID_PATTERN.test('S01'));
});

test('selector-shaped typos are distinguished from prose', () => {
  for (const token of ['S0', 'F007', 'F-1', 'f00']) {
    assert.equal(isMalformedReviewFeedbackToken(token), true, token);
  }
  for (const token of ['F1', 'S3', 'Fix', '2', 'please']) {
    assert.equal(isMalformedReviewFeedbackToken(token), false, token);
  }
});

test('canonicalisation dedupes, preserves order and reports namespace mismatches', () => {
  const canonical = canonicalizeReviewFeedbackSelection({
    findingIds: ['f20', 'F20', 'S3'],
    suggestionIds: ['s5', 's3', 'S0', 'F1'],
  });
  assert.deepEqual(canonical.findingIds, ['F20']);
  assert.deepEqual(canonical.suggestionIds, ['S5', 'S3']);
  // A finding named under suggestionIds is a caller bug, never reclassified.
  assert.deepEqual(canonical.invalid, ['S3', 'S0', 'F1']);
  assert.equal(isEmptyReviewFeedbackSelection(canonicalizeReviewFeedbackSelection({})), true);
});

test('selections render for the command line and for a human receipt', () => {
  const selection = { findingIds: ['F20'], suggestionIds: ['S3', 'S5'] };
  assert.equal(formatReviewFeedbackSelection(selection), 'F20 S3 S5');
  assert.equal(describeReviewFeedbackSelection(selection), 'finding F20 · suggestions S3, S5');
  assert.equal(describeReviewFeedbackSelection({ findingIds: ['F1', 'F2'], suggestionIds: [] }), 'findings F1, F2');
  assert.equal(describeReviewFeedbackSelection({ findingIds: [], suggestionIds: ['S1'] }), 'suggestion S1');
  assert.equal(describeReviewFeedbackSelection({ findingIds: [], suggestionIds: [] }), '');
});
