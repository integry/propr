import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const createTaskState = mock.fn(async () => ({}));
const markTaskFailed = mock.fn(async () => ({}));
const correlatedLogger = { info: mock.fn(), debug: mock.fn(), warn: mock.fn(), error: mock.fn() };

class UsageLimitError extends Error {}

await mock.module('@propr/core', {
    namedExports: {
        logger: { withCorrelation: () => correlatedLogger },
        getAuthenticatedOctokit: mock.fn(async () => {
            throw new Error('GitHub authentication unavailable');
        }),
        withRetry: async (operation: () => Promise<unknown>) => operation(),
        retryConfigs: { githubApi: {} },
        getStateManager: () => ({ createTaskState, markTaskFailed }),
        TaskStates: {},
        createWorktreeForIssue: mock.fn(),
        cleanupWorktree: mock.fn(),
        getRepoUrl: mock.fn(),
        ensureRepoCloned: mock.fn(),
        ensureGitRepository: mock.fn(),
        AgentRegistry: { getInstance: mock.fn() },
        UsageLimitError,
        generateTaskImportPrompt: mock.fn(),
        handleError: mock.fn(),
    },
});
await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: { handleSimpleUsageLimitError: mock.fn() },
});
await mock.module('../src/jobs/prCommentAgentUtils.js', {
    namedExports: { resolveDefaultAgentAndModel: mock.fn() },
});
await mock.module('../src/jobs/notificationRecap.js', {
    namedExports: { compactNotificationRecap: mock.fn() },
});

const { processTaskImportJob } = await import('../src/jobs/processTaskImportJob.js');

test('task import retries reuse the durable task identity of their BullMQ job', async () => {
    const job = {
        id: 'import-tasks-integry-propr-1758800000000',
        name: 'processTaskImport',
        data: {
            taskDescription: 'Import the roadmap',
            repository: 'integry/propr',
            correlationId: 'import-correlation',
            user: 'integry',
        },
    };

    await assert.rejects(processTaskImportJob(job as never), /GitHub authentication unavailable/);
    await assert.rejects(processTaskImportJob(job as never), /GitHub authentication unavailable/);

    const attempts = createTaskState.mock.calls.map(call => ({
        taskId: call.arguments[0],
        jobId: call.arguments[3],
    }));
    assert.deepEqual(attempts, [
        { taskId: `task-import-${job.id}`, jobId: job.id },
        { taskId: `task-import-${job.id}`, jobId: job.id },
    ]);
    assert.deepEqual(
        markTaskFailed.mock.calls.map(call => call.arguments[0]),
        [`task-import-${job.id}`, `task-import-${job.id}`],
    );
});
