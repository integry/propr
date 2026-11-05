import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIssueSummaryMap } from '../routes/plannerDraftHelpers.js';

test('the plans list counts a PR awaiting review as in review, not as a running agent', () => {
  const summary = buildIssueSummaryMap([
    { draft_id: 'plan', status: 'under_review' },
  ]);
  assert.deepEqual(summary.plan, { total: 1, pending: 0, processing: 0, in_review: 1, merged: 0, closed: 0 });
});

test('queued or running implementation and refinement count as running', () => {
  const summary = buildIssueSummaryMap([
    { draft_id: 'plan', status: 'processing' },
    { draft_id: 'plan', status: 'in_refinement' },
    { draft_id: 'plan', status: 'refinement_processing' },
    { draft_id: 'plan', status: 'under_review' },
    { draft_id: 'plan', status: 'pending' },
    { draft_id: 'plan', status: 'merged' },
    { draft_id: 'plan', status: 'closed' },
  ]);
  assert.deepEqual(summary.plan, { total: 7, pending: 1, processing: 3, in_review: 1, merged: 1, closed: 1 });
});
