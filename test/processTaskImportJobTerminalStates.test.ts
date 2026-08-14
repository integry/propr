import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { Job } from 'bullmq';
import type { TaskImportJobData } from '../packages/core/src/queue/taskQueue.types.js';

const completedState = {
    taskId: 'persisted-task-import-id',
    issueRef: {
        number: 0,
        repoOwner: 'integry',
        repoName: 'propr',
        type: 'task_import',
        jobId: 'task-import-job',
    },
    correlationId: 'task-import-correlation',
    state: 'completed',
    createdAt: '2026-08-14T12:00:00.000Z',
    updatedAt: '2026-08-14T12:10:00.000Z',
    attempts: 0,
    history: [],
};
const mockCreateTaskState = mock.fn(async () => completedState);
const mockTerminalResult = mock.fn(async () => ({
    status: 'complete',
    reason: 'task_already_completed',
}));
const mockGetAuthenticatedOctokit = mock.fn(async () => ({
    auth: mock.fn(async () => ({ token: 'token' })),
}));
const mockStateManager = {
    createTaskState: mockCreateTaskState,
    getTerminalJobResultForAutomaticRetry: mockTerminalResult,
    updateTaskState: mock.fn(async () => undefined),
    markTaskCompleted: mock.fn(async () => undefined),
    markTaskFailed: mock.fn(async () => undefined),
};
const logger = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
};

await mock.module('@propr/core', {
    namedExports: {
        logger: { ...logger, withCorrelation: mock.fn(() => logger) },
        getAuthenticatedOctokit: mockGetAuthenticatedOctokit,
        withRetry: mock.fn(async (operation: () => Promise<unknown>) => operation()),
        retryConfigs: { githubApi: {} },
        getStateManager: mock.fn(() => mockStateManager),
        TaskStates: {
            PROCESSING: 'processing',
            CLAUDE_EXECUTION: 'claude_execution',
            POST_PROCESSING: 'post_processing',
        },
        createWorktreeForIssue: mock.fn(),
        cleanupWorktree: mock.fn(),
        getRepoUrl: mock.fn(),
        ensureRepoCloned: mock.fn(),
        ensureGitRepository: mock.fn(),
        AgentRegistry: { getInstance: mock.fn() },
        UsageLimitError: class UsageLimitError extends Error {},
        generateTaskImportPrompt: mock.fn(),
        handleError: mock.fn(),
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: {
        handleSimpleUsageLimitError: mock.fn(),
    },
});

await mock.module('../src/jobs/prCommentAgentUtils.js', {
    namedExports: {
        resolveDefaultAgentAndModel: mock.fn(),
    },
});

const { processTaskImportJob } = await import('../src/jobs/processTaskImportJob.js');

beforeEach(() => {
    mockCreateTaskState.mock.resetCalls();
    mockTerminalResult.mock.resetCalls();
    mockGetAuthenticatedOctokit.mock.resetCalls();
});

function taskImportJob(taskId?: string) {
    const updateData = mock.fn(async function (this: { data: TaskImportJobData }, data: TaskImportJobData) {
        this.data = data;
    });
    const job = {
        id: 'task-import-job',
        name: 'processTaskImport',
        data: {
            taskDescription: 'Import the selected work',
            repository: 'integry/propr',
            correlationId: 'task-import-correlation',
            ...(taskId === undefined ? {} : { taskId }),
        },
        attemptsMade: 1,
        opts: { attempts: 3 },
        updateData,
    } as unknown as Job<TaskImportJobData>;
    return { job, updateData };
}

test('task-import retry preserves its persisted task identity and stops at the terminal gate', async () => {
    const { job, updateData } = taskImportJob('persisted-task-import-id');

    const result = await processTaskImportJob(job);

    assert.deepEqual(result, {
        status: 'complete',
        reason: 'task_already_completed',
        repository: 'integry/propr',
    });
    assert.equal(updateData.mock.calls.length, 0);
    assert.equal(mockCreateTaskState.mock.calls[0].arguments[0], 'persisted-task-import-id');
    assert.deepEqual(mockTerminalResult.mock.calls[0].arguments[2], {
        jobId: 'task-import-job',
        attemptsMade: 1,
        totalAttempts: 3,
    });
    assert.equal(mockGetAuthenticatedOctokit.mock.calls.length, 0);
});

test('task-import creates and persists an identity only when one is absent', async () => {
    const { job, updateData } = taskImportJob();

    await processTaskImportJob(job);

    assert.equal(updateData.mock.calls.length, 1);
    const persistedTaskId = updateData.mock.calls[0].arguments[0].taskId;
    assert.match(String(persistedTaskId), /^task-import-integry-propr-\d+$/);
    assert.equal(mockCreateTaskState.mock.calls[0].arguments[0], persistedTaskId);
});
