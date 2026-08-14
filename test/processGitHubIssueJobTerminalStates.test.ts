import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    TaskStates,
    type TaskState,
    type TaskStateData,
    type TaskStateExpectation,
    type UpdateMetadata,
} from '../packages/core/src/utils/workerStateManager.types.js';

const timestamp = '2026-08-14T10:00:00.000Z';
const taskId = 'integry-propr-1898-test-model-correlation-1898';

function expectation(task: TaskStateData): TaskStateExpectation {
    return {
        state: task.state,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        correlationId: task.correlationId,
        version: task.version,
        historyId: task.historyId,
    };
}

function stateStore(initialState: TaskState) {
    let current: TaskStateData = {
        taskId,
        issueRef: {
            type: 'issue',
            number: 1898,
            repoOwner: 'integry',
            repoName: 'propr',
        },
        correlationId: 'correlation-1898',
        state: initialState,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        attempts: 0,
        history: [{ state: initialState, timestamp, reason: 'Seeded task' }],
    };
    const terminal = new Set<TaskState>([
        TaskStates.COMPLETED,
        TaskStates.FAILED,
        TaskStates.CANCELLED,
    ]);
    const updateTaskState = mock.fn(async (
        _taskId: string,
        newState: TaskState,
        metadata: UpdateMetadata = {},
    ) => {
        if (terminal.has(current.state)) return structuredClone(current);
        const nextTimestamp = new Date(Date.parse(current.updatedAt) + 1).toISOString();
        current = {
            ...current,
            state: newState,
            updatedAt: nextTimestamp,
            version: (current.version ?? 0) + 1,
            history: [...current.history, {
                state: newState,
                timestamp: nextTimestamp,
                reason: metadata.reason ?? 'Updated',
            }],
        };
        return structuredClone(current);
    });
    const updateTaskStateIfCurrentDetailed = mock.fn(async (
        _taskId: string,
        expected: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata = {},
    ) => {
        const currentExpectation = expectation(current);
        if (JSON.stringify(expected) !== JSON.stringify(currentExpectation)) return null;
        const state = await updateTaskState(taskId, newState, metadata);
        return {
            state,
            publication: { historyPersisted: true, eventPublished: true, errors: [] },
        };
    });
    return {
        createTaskState: mock.fn(async () => structuredClone(current)),
        associateTaskWithJob: mock.fn(async () => structuredClone(current)),
        updateTaskState,
        updateTaskStateIfCurrentDetailed,
        getTaskState: mock.fn(async () => structuredClone(current)),
        markTaskFailed: mock.fn(async (_id: string, error: Error) =>
            updateTaskState(taskId, TaskStates.FAILED, { error: { message: error.message } })),
        current: () => structuredClone(current),
    };
}

let activeStore = stateStore(TaskStates.PENDING);

const noOp = mock.fn(async () => undefined);
const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
};

await mock.module('@propr/core', {
    namedExports: {
        TaskStates,
        taskStateExpectation: expectation,
        logger,
        ensureRepoCloned: noOp,
        getRepoUrl: mock.fn(() => 'https://github.com/integry/propr.git'),
        safeAddLabel: noOp,
        safeRemoveLabel: noOp,
        ensureGitRepository: noOp,
        UsageLimitError: class UsageLimitError extends Error {},
        validateRepositoryInfo: mock.fn(),
        addModelSpecificDelay: noOp,
        withRetry: mock.fn(async (operation: () => Promise<unknown>) => operation()),
        retryConfigs: { githubApi: {} },
        updatePlanIssueTaskId: noOp,
    },
});

await mock.module('../src/jobs/issueJobDispatcher.js', {
    namedExports: { handleDispatch: mock.fn() },
});
await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: {
        handleUsageLimitError: noOp,
        handleGenericError: noOp,
        updateTaskTitleInStorage: noOp,
        buildFinalResult: mock.fn(() => ({ status: 'complete' })),
    },
});
await mock.module('../src/jobs/issueJobPostProcessing.js', {
    namedExports: { performFinalValidation: noOp },
});
await mock.module('../src/jobs/issueJob/index.js', {
    namedExports: {
        initializeJobContext: mock.fn(async (job: { id?: string; data: Record<string, unknown> }) => ({
            jobId: job.id,
            issueRef: job.data,
            correlationId: 'correlation-1898',
            correlatedLogger: logger,
            stateManager: activeStore,
            agentAlias: 'test',
            modelName: 'model',
            taskId,
            AI_PROCESSING_TAG: 'AI-processing',
            AI_DONE_TAG: 'AI-done',
            AI_WAITING_TAG: 'AI-waiting',
            AI_PRIMARY_TAG: 'AI',
            PR_LABEL: 'propr',
        })),
        getAuthenticatedClient: mock.fn(async () => ({})),
        checkLabelConditions: (labels: string[]) => {
            if (!labels.includes('AI')) return { skip: true, reason: 'Primary tag missing' };
            if (labels.includes('AI-done')) return { skip: true, reason: 'Already done' };
            return { skip: false };
        },
        ensureProcessingLabel: noOp,
        executeWorktreeOperations: mock.fn(),
        markTaskComplete: noOp,
    },
});

const { processGitHubIssueJob } = await import('../src/jobs/processGitHubIssueJob.js');

function issueJob(labels: string[]) {
    return {
        id: 'issue-job-1898',
        name: 'processGitHubIssue',
        data: {
            isChildJob: true,
            taskId,
            repoOwner: 'integry',
            repoName: 'propr',
            number: 1898,
            issuePayload: { title: 'Header task reconciliation', labels: labels.map(name => ({ name })) },
        },
        updateData: noOp,
        updateProgress: noOp,
    };
}

test('processGitHubIssueJob cancels the durable task when the primary AI label is missing', async () => {
    activeStore = stateStore(TaskStates.PENDING);

    const result = await processGitHubIssueJob(issueJob([]) as never);

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'Primary tag missing');
    assert.equal(activeStore.current().state, TaskStates.CANCELLED);
});

test('processGitHubIssueJob cancels an already-handled label exit', async () => {
    activeStore = stateStore(TaskStates.PENDING);

    const result = await processGitHubIssueJob(issueJob(['AI', 'AI-done']) as never);

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'Already done');
    assert.equal(activeStore.current().state, TaskStates.CANCELLED);
});

test('processGitHubIssueJob preserves an already-completed durable task', async () => {
    activeStore = stateStore(TaskStates.COMPLETED);

    const result = await processGitHubIssueJob(issueJob(['AI']) as never);

    assert.equal(result.status, 'complete');
    assert.equal(result.reason, 'task_already_completed');
    assert.equal(activeStore.current().state, TaskStates.COMPLETED);
    assert.equal(activeStore.updateTaskStateIfCurrentDetailed.mock.calls.length, 0);
});
