import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection, closeStateManager } from '@propr/core';
import { handleNoAuthorizedFindings } from '../src/jobs/prCommentNoAuthorizedFindings.js';

after(async () => {
  await closeStateManager();
  await closeConnection();
});

describe('no-authorized-findings completion recap', () => {
  test('persists the no-change outcome for a manual fix notification', async () => {
    const updates: Array<{ taskId: string; state: string; metadata: Record<string, unknown> }> = [];
    const comments: Array<Record<string, unknown>> = [];

    await handleNoAuthorizedFindings({
      job: { data: {} } as never,
      taskId: 'fix-no-findings',
      taskUrl: 'https://propr.example/tasks/fix-no-findings',
      stateManager: {
        updateTaskState: async (taskId: string, state: string, metadata: Record<string, unknown>) => {
          updates.push({ taskId, state, metadata });
          return {};
        },
      } as never,
      octokit: {
        request: async (_route: string, options: Record<string, unknown>) => {
          comments.push(options);
          return { data: { html_url: 'https://github.com/acme/repo/pull/81#issuecomment-1', body: options.body } };
        },
      } as never,
      unprocessedComments: [],
      redisClient: {} as never,
      repoOwner: 'acme',
      repoName: 'repo',
      pullRequestNumber: 81,
      correlatedLogger: { warn() {} } as never,
      correlationId: 'correlation-1',
    });

    assert.equal(comments.length, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].taskId, 'fix-no-findings');
    assert.equal(updates[0].state, 'completed');
    assert.deepEqual(updates[0].metadata.historyMetadata, {
      commandMode: 'fix',
      notificationRecap: 'No files were changed because no authorized review findings were selected.',
      noAuthorizedReviewFindings: true,
      githubComment: {
        url: 'https://github.com/acme/repo/pull/81#issuecomment-1',
        body: comments[0].body,
      },
    });
  });

  test('names the unresolved and malformed identifiers it could not act on', async () => {
    const updates: Array<{ metadata: Record<string, unknown> }> = [];
    const comments: Array<Record<string, unknown>> = [];

    await handleNoAuthorizedFindings({
      job: { data: {} } as never,
      taskId: 'fix-named-ids',
      taskUrl: 'https://propr.example/tasks/fix-named-ids',
      stateManager: {
        updateTaskState: async (_taskId: string, _state: string, metadata: Record<string, unknown>) => {
          updates.push({ metadata });
          return {};
        },
      } as never,
      octokit: {
        request: async (_route: string, options: Record<string, unknown>) => {
          comments.push(options);
          return { data: { html_url: 'https://github.com/acme/repo/pull/81#issuecomment-2', body: options.body } };
        },
      } as never,
      unprocessedComments: [],
      redisClient: {} as never,
      repoOwner: 'acme',
      repoName: 'repo',
      pullRequestNumber: 81,
      correlatedLogger: { warn() {} } as never,
      correlationId: 'correlation-2',
      unresolved: { findingIds: ['F20'], suggestionIds: ['S3', 'S5'] },
      malformedIds: ['S0'],
    });

    const body = String(comments[0].body);
    assert.match(body, /These are not valid review identifiers: S0\./);
    assert.match(body, /No current review offers finding F20 · suggestions S3, S5\./);
    assert.match(body, /`\/fix F20 S3`/);
    const historyMetadata = updates[0].metadata.historyMetadata as Record<string, unknown>;
    assert.deepEqual(historyMetadata.malformedReviewFeedbackIds, ['S0']);
    assert.deepEqual(historyMetadata.unresolvedReviewFeedback, { findingIds: ['F20'], suggestionIds: ['S3', 'S5'] });
    assert.equal(historyMetadata.noAuthorizedReviewFindings, true);
  });
});
