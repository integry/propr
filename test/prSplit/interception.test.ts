import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import type { Redis } from 'ioredis';
import { closeConnection } from '../../packages/core/src/db/connection.js';
import { processCommentEvent } from '../../packages/core/src/webhook/commentEventHandler.js';
import {
  initializeWebhookHandler,
  processWebhookEvent,
} from '../../packages/core/src/webhook/webhookHandler.js';
import { pollForPullRequestComments } from '../../src/polling/prCommentPolling.js';
import { issueCommentPayload } from './helpers.js';

after(async () => {
  await closeConnection();
});

describe('/split interception boundaries', () => {
  test('intercepts webhook /split before the generic comment processor', async () => {
    const commentProcessor = mock.fn(async () => ({ status: 'accepted' as const }));
    const splitCommentHandler = mock.fn(async () => ({
      handled: true as const,
      disposition: {
        status: 'blocked' as const,
        reason: 'split_execution_not_enabled',
        billing: { seatConsumed: false },
      },
      outcome: 'disabled' as const,
    }));
    await initializeWebhookHandler({
      issueProcessor: mock.fn(async () => undefined),
      commentProcessor,
      commentDeletedHandler: mock.fn(async () => undefined),
      commentEditedHandler: mock.fn(async () => undefined),
      splitCommentHandler,
    });

    const disposition = await processWebhookEvent(
      issueCommentPayload('/split extract auth changes'),
      'issue_comment',
      'correlation-id',
    );
    assert.equal(disposition.reason, 'split_execution_not_enabled');
    assert.equal(splitCommentHandler.mock.callCount(), 1);
    assert.equal(commentProcessor.mock.callCount(), 0);
  });

  test('the generic synthetic-comment path skips /split without touching Redis', async () => {
    const redisGet = mock.fn(async () => null);
    const result = await processCommentEvent(
      issueCommentPayload('/split extract auth changes'),
      'issue_comment',
      'synthetic-correlation-id',
      {
        redisClient: { get: redisGet } as unknown as Redis,
        PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
      },
    );
    assert.deepEqual(result, { status: 'ignored', reason: 'not_pull_request_comment' });
    assert.equal(redisGet.mock.callCount(), 0);
  });

  test('polling skips /split without claiming or enqueueing generic follow-up work', async () => {
    const redisGet = mock.fn(async () => null);
    const paginate = mock.fn(async (endpoint: string): Promise<unknown[]> => {
      if (endpoint === 'GET /repos/{owner}/{repo}/pulls') {
        return [{
          number: 1735,
          title: 'Split this PR',
          labels: [{ name: 'AI' }],
          head: { ref: 'feature' },
        }];
      }
      if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return [{
          id: 9001,
          body: '/split extract auth changes',
          user: { login: 'maintainer' },
          created_at: '2026-08-04T00:00:00.000Z',
        }];
      }
      return [];
    });
    const octokit = {
      paginate: async <T>(endpoint: string, _options: Record<string, unknown>): Promise<T[]> => (
        await paginate(endpoint)
      ) as T[],
    };

    await pollForPullRequestComments(octokit, 'integry/propr', 'poll-correlation-id', {
      redisClient: { get: redisGet } as unknown as Redis,
      PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
      MODEL_LABEL_PATTERN: '^llm-(.+)$',
    });
    assert.equal(paginate.mock.callCount(), 3);
    assert.equal(redisGet.mock.callCount(), 0);
  });
});
