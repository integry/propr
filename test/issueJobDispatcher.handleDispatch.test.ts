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

function dispatcherFixture() {
    const queuedJobs: Array<{
      jobName: string;
      jobData: IssueJobData;
      options: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
    }> = [];
    const order: string[] = [];
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
        resolveSubmissionRetry: async () => null,
      findSubmission: async () => undefined,
        recordDispatch: async () => undefined,
        recordDispatchFailure: async () => undefined,
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
          order.push(`enqueue:${jobData.correlationId}`);
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
      registerRequest: mock.fn(async (issue: IssueJobData) => { order.push(`register:${issue.correlationId}`); }),
    } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
    return { queuedJobs, order, deps };
}

function parentJob(data: Partial<IssueJobData> = {}): Job<IssueJobData> {
    return {
      id: 'parent-job',
      name: 'processGitHubIssue',
      data: {
        repoOwner: 'integry',
        repoName: 'propr',
        number: 1701,
        correlationId: 'test-correlation',
        ...data,
      },
      updateData: async () => undefined,
    } as unknown as Job<IssueJobData>;
}

describe('issueJobDispatcher handleDispatch', () => {
  test('reads GitHub label objects and stamps the parsed reasoning level onto queued child jobs', async () => {
    const { queuedJobs, order, deps } = dispatcherFixture();
    const result = await handleDispatchWithDeps(parentJob(), deps);

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
    // Children of one dispatch share its ID, so a sibling's done label does not skip the others.
    assert.equal(queuedJobs[0].jobData.dispatchId, 'parent-job');
    // The request is ordered before any child exists, so a child that runs late is still known to be older.
    assert.deepEqual(order, ['register:test-correlation', 'enqueue:test-correlation']);
  });

  const pluginCommand = { pluginId: 'example-pack', command: 'example-notes', instruction: 'Write notes', extensions: { servers: [], skills: [] } };

  test('settles the plugin command intent the job names before any child carries the command', async () => {
    const { queuedJobs, order, deps } = dispatcherFixture();
    const settled: IssueJobData[] = [];
    deps.settleIssueCommand = async issue => { settled.push(issue); order.push(`settle:${issue.pluginCommandIntent}`); };
    const result = await handleDispatchWithDeps(parentJob({ pluginCommand, pluginCommandIntent: 'intent-token' } as Partial<IssueJobData>), deps);
    assert.equal(result.status, 'dispatched');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].pluginCommandIntent, 'intent-token');
    assert.deepEqual(order, ['settle:intent-token', 'register:test-correlation', 'enqueue:test-correlation']);
    assert.deepEqual(queuedJobs[0].jobData.pluginCommand, pluginCommand);
  });

  test('an intent that cannot be settled fails the attempt before any child is queued; a job without one settles nothing', async () => {
    const failing = dispatcherFixture();
    failing.deps.settleIssueCommand = async () => { throw new Error('redis unavailable'); };
    await assert.rejects(handleDispatchWithDeps(parentJob({ pluginCommand, pluginCommandIntent: 'intent-token' } as Partial<IssueJobData>), failing.deps), /redis unavailable/);
    assert.equal(failing.queuedJobs.length, 0, 'no child carries the command while its intent is pending');

    const ordinary = dispatcherFixture();
    const settle = mock.fn(async () => undefined);
    ordinary.deps.settleIssueCommand = settle;
    assert.equal((await handleDispatchWithDeps(parentJob(), ordinary.deps)).status, 'dispatched');
    assert.equal(settle.mock.callCount(), 0);
  });
});
