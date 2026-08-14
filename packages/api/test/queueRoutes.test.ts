import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import { createQueueRoutes } from '../routes/queueRoutes.js';

function createJsonResponse(): {
  response: ExpressResponse;
  status: () => number;
  body: () => Record<string, unknown>;
} {
  let statusCode = 200;
  let payload: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      return response;
    },
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => payload };
}

test('/api/queue/stats returns each active job once using queue metadata only', async () => {
  const requestedStates: string[][] = [];
  const taskQueue = {
    getWaitingCount: async () => 3,
    getCompletedCount: async () => 8,
    getFailedCount: async () => 1,
    getDelayedCount: async () => 2,
    getJobs: async (states: string[]) => {
      requestedStates.push(states);
      return [
        {
          id: 'issue-job-1',
          name: 'processGitHubIssue',
          timestamp: Date.parse('2026-08-14T20:00:00.000Z'),
          data: {
            repoOwner: 'integry',
            repoName: 'propr',
            number: 1906,
            agentAlias: 'codex',
            modelName: 'gpt-5.6-sol',
            correlationId: 'corr-1',
            isChildJob: true,
            issuePayload: { title: 'Use live queue jobs' },
          },
        },
        {
          id: 'pr-job-2',
          name: 'processPullRequestComment',
          timestamp: Date.parse('2026-08-14T20:01:00.000Z'),
          data: { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 1907 },
        },
        {
          id: 'issue-job-1',
          name: 'processGitHubIssue',
          timestamp: Date.parse('2026-08-14T20:02:00.000Z'),
          data: { repoOwner: 'integry', repoName: 'propr', number: 1906 },
        },
      ];
    },
  };
  const { response, status, body } = createJsonResponse();
  const routes = createQueueRoutes({ redisClient: {} as never, taskQueue: taskQueue as never });

  await routes.getQueueStats({} as Request, response);

  assert.equal(status(), 200);
  assert.deepEqual(requestedStates, [['active']], 'waiting and delayed jobs are not Running');
  assert.deepEqual(body(), {
    waiting: 3,
    active: 2,
    activeJobs: [
      {
        id: 'issue-job-1',
        taskId: 'integry-propr-1906-codex-gpt-5.6-sol-corr-1',
        name: 'processGitHubIssue',
        title: 'Use live queue jobs',
        repository: 'integry/propr',
        createdAt: '2026-08-14T20:00:00.000Z',
      },
      {
        id: 'pr-job-2',
        taskId: 'pr-job-2',
        name: 'processPullRequestComment',
        title: 'Pull request #1907',
        repository: 'integry/propr',
        createdAt: '2026-08-14T20:01:00.000Z',
      },
    ],
    completed: 8,
    failed: 1,
    delayed: 2,
    total: 16,
  });
});

test('/api/queue/stats fails read-only when active-job lookup fails', async () => {
  const errorLog = console.error;
  console.error = () => undefined;
  try {
    const taskQueue = {
      getWaitingCount: async () => 0,
      getCompletedCount: async () => 0,
      getFailedCount: async () => 0,
      getDelayedCount: async () => 0,
      getJobs: async () => { throw new Error('Redis unavailable'); },
    };
    const { response, status, body } = createJsonResponse();
    const routes = createQueueRoutes({ redisClient: {} as never, taskQueue: taskQueue as never });

    await routes.getQueueStats({} as Request, response);

    assert.equal(status(), 500);
    assert.deepEqual(body(), { error: 'Internal server error' });
  } finally {
    console.error = errorLog;
  }
});
