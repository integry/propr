import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import type { IssueJobData } from '@propr/core';

process.env.PROPR_DEMO_MODE = 'true';

const { handleDispatchWithDeps } = await import('../src/jobs/issueJobDispatcher.ts');
const { closeConnection } = await import('../packages/core/src/db/connection.ts');

after(async () => {
  await closeConnection();
});

describe('issueJobDispatcher handleDispatch', () => {
  test('reads GitHub label objects and stamps the parsed reasoning level onto queued child jobs', async () => {
    const queuedJobs: Array<{
      jobName: string;
      jobData: IssueJobData;
      options: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
    }> = [];
    const mockOctokit = {
      request: mock.fn(async () => ({
        data: {
          labels: [
            { name: 'AI' },
            { name: 'level-low' },
            { name: 'level-max' },
            { name: 'base-develop' },
            { name: 'llm-codex-gpt55' },
          ],
        },
      })),
    };
    const deps = {
      getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
      withRetry: mock.fn(async (fn: () => Promise<unknown>) => fn()),
      retryConfigs: {
        githubApi: {},
      },
      validateRepositoryInfo: mock.fn(async () => ({
        isValid: true,
        repoData: {
          defaultBranch: 'main',
        },
      })),
      issueQueue: {
        add: mock.fn(async (
          jobName: string,
          jobData: IssueJobData,
          options: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean }
        ) => {
          queuedJobs.push({ jobName, jobData, options });
        }),
      },
      getDefaultModel: mock.fn(() => 'fallback-model'),
      resolveLlmLabel: mock.fn(async () => ({
        agentAlias: 'codex',
        model: 'codex:gpt-5.5',
      })),
      resolveCustomLabel: mock.fn(async () => null),
      getAllCustomLabels: mock.fn(async () => []),
      resolveDefaultAgentForDispatcher: mock.fn(async () => ({
        agentAlias: 'default',
        modelToUse: 'fallback-model',
      })),
    } as unknown as Parameters<typeof handleDispatchWithDeps>[1];

    const result = await handleDispatchWithDeps({
      id: 'parent-job',
      name: 'processGitHubIssue',
      data: {
        repoOwner: 'integry',
        repoName: 'propr',
        number: 1701,
        correlationId: 'test-correlation',
      },
    } as Job<IssueJobData>, deps);

    assert.deepEqual(result, {
      status: 'dispatched',
      jobsEnqueued: 1,
      issueNumber: 1701,
    });
    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].jobName, 'processGitHubIssue');
    assert.equal(queuedJobs[0].jobData.reasoningLevel, 'max');
    assert.equal(queuedJobs[0].jobData.baseBranch, 'develop');
    assert.equal(queuedJobs[0].jobData.agentAlias, 'codex');
    assert.equal(queuedJobs[0].jobData.modelName, 'codex:gpt-5.5');
    assert.equal(queuedJobs[0].options.jobId, 'issue-integry-propr-1701-codex-codex:gpt-5.5-develop');
  });
});
