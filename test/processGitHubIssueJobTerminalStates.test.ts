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
        const isExplicitFailedRetry = current.state === TaskStates.FAILED
            && newState === TaskStates.PROCESSING
            && metadata.isRetry === true;
        if (terminal.has(current.state) && !isExplicitFailedRetry) return structuredClone(current);
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
let authenticationError: Error | undefined;

const noOp = mock.fn(async () => undefined);
const safeAddLabel = mock.fn(async () => undefined);
const safeRemoveLabel = mock.fn(async () => undefined);
const updatePlanIssueTaskId = mock.fn(async () => undefined);
const getAuthenticatedClient = mock.fn(async () => {
    if (authenticationError) throw authenticationError;
    return {};
});
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
        safeAddLabel,
        safeRemoveLabel,
        ensureGitRepository: noOp,
        UsageLimitError: class UsageLimitError extends Error {},
        validateRepositoryInfo: mock.fn(),
        addModelSpecificDelay: noOp,
        withRetry: mock.fn(async (operation: () => Promise<unknown>) => operation()),
        retryConfigs: { githubApi: {} },
        updatePlanIssueTaskId,
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
        getAuthenticatedClient,
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

function issueJob(labels: string[], overrides: Record<string, unknown> = {}) {
    return {
        id: 'issue-job-1898',
        attemptsMade: 0,
        name: 'processGitHubIssue',
        data: {
            isChildJob: true,
            taskId,
            repoOwner: 'integry',
            repoName: 'propr',
            number: 1898,
            issuePayload: { title: 'Header task reconciliation', labels: labels.map(name => ({ name })) },
            ...overrides,
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

test('processGitHubIssueJob returns a terminal task before authentication can fail', async () => {
    activeStore = stateStore(TaskStates.COMPLETED);
    authenticationError = new Error('GitHub authentication failed');
    getAuthenticatedClient.mock.resetCalls();
    updatePlanIssueTaskId.mock.resetCalls();

    const result = await processGitHubIssueJob(issueJob(['AI']) as never);
    authenticationError = undefined;

    assert.equal(result.status, 'complete');
    assert.equal(result.reason, 'task_already_completed');
    assert.equal(activeStore.current().state, TaskStates.COMPLETED);
    assert.equal(getAuthenticatedClient.mock.calls.length, 0);
    assert.equal(updatePlanIssueTaskId.mock.calls.length, 0);
    assert.equal(activeStore.updateTaskStateIfCurrentDetailed.mock.calls.length, 0);
});

test('processGitHubIssueJob preserves an exhausted failed task', async () => {
    activeStore = stateStore(TaskStates.FAILED);
    authenticationError = new Error('GitHub authentication failed');
    getAuthenticatedClient.mock.resetCalls();

    const result = await processGitHubIssueJob(issueJob(['AI']) as never);
    authenticationError = undefined;

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'task_already_failed');
    assert.equal(activeStore.current().state, TaskStates.FAILED);
    assert.equal(getAuthenticatedClient.mock.calls.length, 0);
});

test('processGitHubIssueJob does not swap labels for a terminal rate-limit retry', async () => {
    activeStore = stateStore(TaskStates.CANCELLED);
    safeAddLabel.mock.resetCalls();
    safeRemoveLabel.mock.resetCalls();
    getAuthenticatedClient.mock.resetCalls();

    const result = await processGitHubIssueJob(issueJob(['AI'], { isRetryFromRateLimit: true }) as never);

    assert.equal(result.status, 'cancelled');
    assert.equal(result.reason, 'task_already_cancelled');
    assert.equal(activeStore.current().state, TaskStates.CANCELLED);
    assert.equal(getAuthenticatedClient.mock.calls.length, 0);
    assert.equal(safeRemoveLabel.mock.calls.length, 0);
    assert.equal(safeAddLabel.mock.calls.length, 0);
});

test('processGitHubIssueJob resumes processing after a transient BullMQ attempt failure', async () => {
    activeStore = stateStore(TaskStates.PENDING);
    authenticationError = new Error('Transient GitHub authentication failure');
    getAuthenticatedClient.mock.resetCalls();

    await assert.rejects(
        processGitHubIssueJob(issueJob([]) as never),
        authenticationError,
    );
    assert.equal(activeStore.current().state, TaskStates.FAILED);

    authenticationError = undefined;
    const result = await processGitHubIssueJob({ ...issueJob([]), attemptsMade: 1 } as never);

    assert.equal(result.status, 'skipped');
    assert.equal(getAuthenticatedClient.mock.calls.length, 2);
    assert.equal(activeStore.current().state, TaskStates.CANCELLED);
    assert.equal(activeStore.updateTaskState.mock.calls.some(call =>
        call.arguments[1] === TaskStates.PROCESSING && call.arguments[2]?.isRetry === true), true);
});
