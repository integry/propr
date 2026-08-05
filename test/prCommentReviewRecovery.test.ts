import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, shutdownQueue } from '@propr/core';
import {
    buildReviewAssignmentMarker,
    recoverPublishedReview,
    type ReviewAssignment,
} from '../src/jobs/prCommentReviewRecovery.js';

const assignment: ReviewAssignment = {
    agentAlias: 'codex',
    model: 'gpt-review',
    label: 'review-primary',
};

test('review assignment markers are deterministic and distinguish assignment indexes', () => {
    const first = buildReviewAssignmentMarker('task-1748', assignment, 0, 'success');

    assert.equal(first, buildReviewAssignmentMarker('task-1748', assignment, 0, 'success'));
    assert.notEqual(first, buildReviewAssignmentMarker('task-1748', assignment, 1, 'success'));
    assert.notEqual(first, buildReviewAssignmentMarker('task-1748', assignment, 0, 'error'));
});

test('recovers only bot-published assignment evidence', () => {
    const marker = buildReviewAssignmentMarker('task-1748', assignment, 0, 'success');
    const userResult = recoverPublishedReview([
        { user: { type: 'User' }, body: marker, html_url: 'https://example.test/user' },
    ], 'task-1748', assignment, 0);
    const botResult = recoverPublishedReview([
        { user: { type: 'Bot' }, body: `review\n${marker}`, html_url: 'https://example.test/bot' },
    ], 'task-1748', assignment, 0);

    assert.equal(userResult, null);
    assert.equal(botResult?.recovered, true);
    assert.equal(botResult?.analysisResult.success, true);
    assert.equal(botResult?.commentUrl, 'https://example.test/bot');
});

after(async () => {
    await closeConnection();
    await shutdownQueue();
});
