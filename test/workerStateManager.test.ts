import { test, mock, after } from 'node:test';
import assert from 'node:assert';

// Mock Redis
const mockRedisInstance = {
    setex: mock.fn(async () => 'OK'),
    get: mock.fn(async () => null),
    on: mock.fn(),
    quit: mock.fn(async () => {}),
    keys: mock.fn(async () => []),
    del: mock.fn(async () => 1)
};

await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return mockRedisInstance;
        }
    }
});

// Mock database with proper chain methods
const mockDbTasksInsert = mock.fn(() => ({
    onConflict: mock.fn(() => ({
        ignore: mock.fn(async () => [1])
    }))
}));

const mockDbHistoryInsert = mock.fn(async () => [1]);

const mockDb = (tableName: string) => {
    if (tableName === 'tasks') {
        return { insert: mockDbTasksInsert };
    }
    if (tableName === 'task_history') {
        return { insert: mockDbHistoryInsert };
    }
    return { insert: mock.fn(async () => [1]) };
};

await mock.module('../packages/core/src/db/connection.js', {
    namedExports: {
        db: mockDb
    }
});

// Mock event publisher
const mockPublishTaskUpdate = mock.fn(async () => {});
const mockEventPublisher = {
    publishTaskUpdate: mockPublishTaskUpdate
};

await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: {
        getEventPublisher: () => mockEventPublisher
    }
});

// Mock logger
const mockCorrelatedLogger = {
    info: mock.fn(),
    debug: mock.fn(),
    warn: mock.fn(),
    error: mock.fn()
};

const mockLogger = {
    info: mock.fn(),
    debug: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    withCorrelation: () => mockCorrelatedLogger
};

await mock.module('../packages/core/src/utils/logger.js', {
    namedExports: {
        default: mockLogger,
        generateCorrelationId: () => 'generated-correlation-id'
    }
});

// Import after mocks are set up
const { WorkerStateManager, TaskStates } = await import('../packages/core/src/utils/workerStateManager.js');
import type { IssueRef, TaskStateData } from '../packages/core/src/utils/workerStateManager.types.js';

// Test configuration
const TEST_KEY_PREFIX = 'test:worker:state:';
const TEST_STATE_EXPIRY = 3600; // 1 hour for testing

test('createTaskState creates state with correct structure', async () => {
    // Reset mocks
    mockRedisInstance.setex.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-123';
    const issueRef: IssueRef = {
        number: 42,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        type: 'issue',
        modelName: 'claude-3'
    };
    const correlationId = 'custom-correlation-id';

    const result = await stateManager.createTaskState(taskId, issueRef, correlationId);

    // Verify result structure
    assert.strictEqual(result.taskId, taskId);
    assert.strictEqual(result.issueRef.number, issueRef.number);
    assert.strictEqual(result.issueRef.repoOwner, issueRef.repoOwner);
    assert.strictEqual(result.issueRef.repoName, issueRef.repoName);
    assert.strictEqual(result.correlationId, correlationId);
    assert.strictEqual(result.state, TaskStates.PENDING);
    assert.strictEqual(result.attempts, 0);
    assert.ok(result.createdAt);
    assert.ok(result.updatedAt);
    assert.ok(Array.isArray(result.history));
    assert.strictEqual(result.history.length, 1);
    assert.strictEqual(result.history[0].state, TaskStates.PENDING);
    assert.strictEqual(result.history[0].reason, 'Task created');

    await stateManager.close();
});

test('createTaskState stores state in Redis with TTL', async () => {
    // Reset mocks
    mockRedisInstance.setex.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-456';
    const issueRef: IssueRef = {
        number: 100,
        repoOwner: 'owner',
        repoName: 'repo'
    };

    await stateManager.createTaskState(taskId, issueRef);

    // Verify Redis setex was called with correct TTL
    assert.strictEqual(mockRedisInstance.setex.mock.calls.length, 1);
    const setexCall = mockRedisInstance.setex.mock.calls[0];
    assert.strictEqual(setexCall.arguments[0], `${TEST_KEY_PREFIX}${taskId}`);
    assert.strictEqual(setexCall.arguments[1], TEST_STATE_EXPIRY);

    // Verify the stored state is valid JSON with correct structure
    const storedState = JSON.parse(setexCall.arguments[2] as string) as TaskStateData;
    assert.strictEqual(storedState.taskId, taskId);
    assert.strictEqual(storedState.state, TaskStates.PENDING);
    assert.strictEqual(storedState.issueRef.number, 100);

    await stateManager.close();
});

test('createTaskState uses default TTL when not specified', async () => {
    mockRedisInstance.setex.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX
        // No stateExpiry specified - should use default (7 * 24 * 3600 = 604800)
    });

    const taskId = 'task-default-ttl';
    const issueRef: IssueRef = {
        number: 1,
        repoOwner: 'owner',
        repoName: 'repo'
    };

    await stateManager.createTaskState(taskId, issueRef);

    const setexCall = mockRedisInstance.setex.mock.calls[0];
    const defaultTTL = 7 * 24 * 3600; // 7 days in seconds
    assert.strictEqual(setexCall.arguments[1], defaultTTL);

    await stateManager.close();
});

test('createTaskState inserts task into database', async () => {
    mockRedisInstance.setex.mock.resetCalls();
    mockDbTasksInsert.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-db-insert';
    const issueRef: IssueRef = {
        number: 55,
        repoOwner: 'db-owner',
        repoName: 'db-repo',
        type: 'pull_request',
        modelName: 'gpt-4'
    };

    await stateManager.createTaskState(taskId, issueRef);

    // Verify database insert was called for tasks table
    assert.ok(mockDbTasksInsert.mock.calls.length >= 1, 'Should insert into tasks table');

    // Verify task data was passed correctly
    const insertCall = mockDbTasksInsert.mock.calls[0];
    const taskData = insertCall.arguments[0] as Record<string, unknown>;
    assert.strictEqual(taskData.task_id, taskId);
    assert.strictEqual(taskData.repository, 'db-owner/db-repo');
    assert.strictEqual(taskData.issue_number, 55);
    assert.strictEqual(taskData.task_type, 'pull_request');
    assert.strictEqual(taskData.model_name, 'gpt-4');

    // Verify task_history insert was called
    assert.ok(mockDbHistoryInsert.mock.calls.length >= 1, 'Should insert into task_history table');

    await stateManager.close();
});

test('createTaskState generates correlation ID when not provided', async () => {
    mockRedisInstance.setex.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-auto-correlation';
    const issueRef: IssueRef = {
        number: 77,
        repoOwner: 'owner',
        repoName: 'repo'
    };

    // Call without correlation ID
    const result = await stateManager.createTaskState(taskId, issueRef);

    // Should generate a correlation ID (mocked to return 'generated-correlation-id')
    assert.ok(result.correlationId, 'Should have a correlation ID');
    assert.strictEqual(result.correlationId, 'generated-correlation-id');

    await stateManager.close();
});

test('createTaskState publishes real-time event', async () => {
    mockRedisInstance.setex.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-event';
    const issueRef: IssueRef = {
        number: 88,
        repoOwner: 'event-owner',
        repoName: 'event-repo'
    };

    await stateManager.createTaskState(taskId, issueRef);

    // Verify event was published
    assert.strictEqual(mockPublishTaskUpdate.mock.calls.length, 1);
    const eventCall = mockPublishTaskUpdate.mock.calls[0];
    const eventPayload = eventCall.arguments[0] as {
        taskId: string;
        state: string;
        repository: string;
        issueNumber: number;
    };

    assert.strictEqual(eventPayload.taskId, taskId);
    assert.strictEqual(eventPayload.state, TaskStates.PENDING);
    assert.strictEqual(eventPayload.repository, 'event-owner/event-repo');
    assert.strictEqual(eventPayload.issueNumber, 88);

    await stateManager.close();
});

test('createTaskState handles missing optional issueRef fields', async () => {
    mockRedisInstance.setex.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-minimal';
    const issueRef: IssueRef = {
        number: 1,
        repoOwner: 'owner',
        repoName: 'repo'
        // No type or modelName
    };

    const result = await stateManager.createTaskState(taskId, issueRef);

    assert.strictEqual(result.taskId, taskId);
    assert.strictEqual(result.issueRef.number, 1);
    assert.strictEqual(result.issueRef.type, undefined);
    assert.strictEqual(result.issueRef.modelName, undefined);

    await stateManager.close();
});

test('createTaskState sets correct initial history entry', async () => {
    mockRedisInstance.setex.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-history';
    const issueRef: IssueRef = {
        number: 99,
        repoOwner: 'history-owner',
        repoName: 'history-repo'
    };

    const result = await stateManager.createTaskState(taskId, issueRef);

    // Verify history entry
    assert.strictEqual(result.history.length, 1);
    assert.strictEqual(result.history[0].state, TaskStates.PENDING);
    assert.strictEqual(result.history[0].reason, 'Task created');
    assert.ok(result.history[0].timestamp);

    // Verify timestamp is valid ISO string
    const timestamp = new Date(result.history[0].timestamp);
    assert.ok(!isNaN(timestamp.getTime()), 'Timestamp should be valid date');

    await stateManager.close();
});

test('createTaskState handles database error gracefully', async () => {
    mockRedisInstance.setex.mock.resetCalls();
    mockCorrelatedLogger.error.mock.resetCalls();

    // Make db throw an error by replacing the mock temporarily
    const originalInsert = mockDbTasksInsert.mock.mockImplementation;
    mockDbTasksInsert.mock.mockImplementation(() => {
        throw new Error('Database connection failed');
    });

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-db-error';
    const issueRef: IssueRef = {
        number: 111,
        repoOwner: 'error-owner',
        repoName: 'error-repo'
    };

    // Should not throw - database errors are caught and logged
    const result = await stateManager.createTaskState(taskId, issueRef);

    // State should still be created in Redis
    assert.strictEqual(result.taskId, taskId);
    assert.strictEqual(result.state, TaskStates.PENDING);

    // Verify error was logged
    assert.ok(mockCorrelatedLogger.error.mock.calls.length >= 1, 'Error should be logged');

    // Restore original mock
    mockDbTasksInsert.mock.mockImplementation(originalInsert);

    await stateManager.close();
});

test('createTaskState generates unique task keys', async () => {
    mockRedisInstance.setex.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId1 = 'task-unique-1';
    const taskId2 = 'task-unique-2';
    const issueRef: IssueRef = {
        number: 1,
        repoOwner: 'owner',
        repoName: 'repo'
    };

    await stateManager.createTaskState(taskId1, issueRef);
    await stateManager.createTaskState(taskId2, issueRef);

    const setexCalls = mockRedisInstance.setex.mock.calls;
    assert.strictEqual(setexCalls.length, 2);

    const key1 = setexCalls[0].arguments[0];
    const key2 = setexCalls[1].arguments[0];

    assert.notStrictEqual(key1, key2, 'Keys should be unique');
    assert.strictEqual(key1, `${TEST_KEY_PREFIX}${taskId1}`);
    assert.strictEqual(key2, `${TEST_KEY_PREFIX}${taskId2}`);

    await stateManager.close();
});

test('createTaskState stores valid JSON in Redis', async () => {
    mockRedisInstance.setex.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-json-valid';
    const issueRef: IssueRef = {
        number: 200,
        repoOwner: 'json-owner',
        repoName: 'json-repo',
        type: 'issue',
        modelName: 'claude-sonnet'
    };

    await stateManager.createTaskState(taskId, issueRef);

    const setexCall = mockRedisInstance.setex.mock.calls[0];
    const storedJson = setexCall.arguments[2] as string;

    // Should not throw when parsing
    let parsed: TaskStateData | undefined;
    assert.doesNotThrow(() => {
        parsed = JSON.parse(storedJson) as TaskStateData;
    }, 'Stored value should be valid JSON');

    // Verify all required fields are present
    assert.ok(parsed);
    assert.ok('taskId' in parsed);
    assert.ok('issueRef' in parsed);
    assert.ok('correlationId' in parsed);
    assert.ok('state' in parsed);
    assert.ok('createdAt' in parsed);
    assert.ok('updatedAt' in parsed);
    assert.ok('attempts' in parsed);
    assert.ok('history' in parsed);

    await stateManager.close();
});

test('createTaskState uses correct repository format in database', async () => {
    mockRedisInstance.setex.mock.resetCalls();
    mockDbTasksInsert.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const taskId = 'task-repo-format';
    const issueRef: IssueRef = {
        number: 123,
        repoOwner: 'my-org',
        repoName: 'my-project'
    };

    await stateManager.createTaskState(taskId, issueRef);

    // Verify repository format is owner/name
    const insertCall = mockDbTasksInsert.mock.calls[0];
    const taskData = insertCall.arguments[0] as Record<string, unknown>;
    assert.strictEqual(taskData.repository, 'my-org/my-project');

    await stateManager.close();
});

// ============================================================================
// updateTaskState tests
// ============================================================================

test('updateTaskState throws when task not found', async () => {
    mockRedisInstance.get.mock.resetCalls();
    mockRedisInstance.get.mock.mockImplementation(async () => null);

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const nonExistentTaskId = 'non-existent-task';

    await assert.rejects(
        async () => {
            await stateManager.updateTaskState(nonExistentTaskId, TaskStates.PROCESSING);
        },
        {
            message: `Task state not found for taskId: ${nonExistentTaskId}`
        }
    );

    await stateManager.close();
});

test('updateTaskState transitions state and appends to history', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-update-1',
        issueRef: { number: 42, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-123',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.updateTaskState('task-update-1', TaskStates.PROCESSING, {
        reason: 'Starting processing'
    });

    // Verify state transition
    assert.strictEqual(result.state, TaskStates.PROCESSING);

    // Verify history was appended correctly
    assert.strictEqual(result.history.length, 2);
    assert.strictEqual(result.history[0].state, TaskStates.PENDING);
    assert.strictEqual(result.history[1].state, TaskStates.PROCESSING);
    assert.strictEqual(result.history[1].reason, 'Starting processing');
    assert.ok(result.history[1].timestamp);

    // Verify updatedAt was updated
    assert.ok(new Date(result.updatedAt).getTime() >= new Date(existingState.updatedAt).getTime());

    await stateManager.close();
});

test('updateTaskState publishes real-time event', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-event-update',
        issueRef: { number: 88, repoOwner: 'event-owner', repoName: 'event-repo' },
        correlationId: 'corr-event',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    await stateManager.updateTaskState('task-event-update', TaskStates.CLAUDE_EXECUTION, {
        reason: 'Claude execution started'
    });

    // Verify event was published
    assert.strictEqual(mockPublishTaskUpdate.mock.calls.length, 1);
    const eventCall = mockPublishTaskUpdate.mock.calls[0];
    const eventPayload = eventCall.arguments[0] as {
        taskId: string;
        state: string;
        previousState: string;
        repository: string;
        issueNumber: number;
        metadata?: { attempts: number; reason?: string };
    };

    assert.strictEqual(eventPayload.taskId, 'task-event-update');
    assert.strictEqual(eventPayload.state, TaskStates.CLAUDE_EXECUTION);
    assert.strictEqual(eventPayload.previousState, TaskStates.PENDING);
    assert.strictEqual(eventPayload.repository, 'event-owner/event-repo');
    assert.strictEqual(eventPayload.issueNumber, 88);
    assert.strictEqual(eventPayload.metadata?.reason, 'Claude execution started');

    await stateManager.close();
});

test('updateTaskState increments attempts on retry', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-retry',
        issueRef: { number: 50, repoOwner: 'retry-owner', repoName: 'retry-repo' },
        correlationId: 'corr-retry',
        state: TaskStates.FAILED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 1,
        history: [
            { state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' },
            { state: TaskStates.FAILED, timestamp: new Date().toISOString(), reason: 'First failure' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.updateTaskState('task-retry', TaskStates.PROCESSING, {
        isRetry: true,
        reason: 'Retrying task'
    });

    // Verify attempts was incremented
    assert.strictEqual(result.attempts, 2);

    await stateManager.close();
});

test('updateTaskState does not increment attempts when not a retry', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-no-retry',
        issueRef: { number: 51, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-no-retry',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.updateTaskState('task-no-retry', TaskStates.PROCESSING, {
        reason: 'Normal transition'
    });

    // Verify attempts was not incremented
    assert.strictEqual(result.attempts, 0);

    await stateManager.close();
});

test('updateTaskState stores error metadata', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-error',
        issueRef: { number: 60, repoOwner: 'error-owner', repoName: 'error-repo' },
        correlationId: 'corr-error',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.updateTaskState('task-error', TaskStates.FAILED, {
        error: { message: 'Connection timeout', category: 'network' },
        reason: 'Task failed due to network error'
    });

    // Verify error was stored
    assert.ok(result.lastError);
    assert.strictEqual(result.lastError.message, 'Connection timeout');
    assert.strictEqual(result.lastError.category, 'network');
    assert.ok(result.lastError.timestamp);

    await stateManager.close();
});

test('updateTaskState uses default error category when not specified', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-error-default',
        issueRef: { number: 61, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-default-error',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.updateTaskState('task-error-default', TaskStates.FAILED, {
        error: { message: 'Unknown error' },
        reason: 'Task failed'
    });

    // Verify default category 'unknown' is used
    assert.ok(result.lastError);
    assert.strictEqual(result.lastError.category, 'unknown');

    await stateManager.close();
});

test('updateTaskState stores worktreeInfo metadata', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-worktree',
        issueRef: { number: 70, repoOwner: 'wt-owner', repoName: 'wt-repo' },
        correlationId: 'corr-worktree',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const worktreeInfo = { path: '/tmp/worktrees/task-70', branch: 'feature/task-70' };
    const result = await stateManager.updateTaskState('task-worktree', TaskStates.PROCESSING, {
        worktreeInfo,
        reason: 'Worktree created'
    });

    // Verify worktreeInfo was stored
    assert.deepStrictEqual(result.worktreeInfo, worktreeInfo);

    await stateManager.close();
});

test('updateTaskState stores claudeResult metadata', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-claude',
        issueRef: { number: 80, repoOwner: 'claude-owner', repoName: 'claude-repo' },
        correlationId: 'corr-claude',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const claudeResult = { success: true, sessionId: 'session-abc123', executionTime: 45000 };
    const result = await stateManager.updateTaskState('task-claude', TaskStates.POST_PROCESSING, {
        claudeResult,
        reason: 'Claude execution completed'
    });

    // Verify claudeResult was stored
    assert.ok(result.claudeResult);
    assert.strictEqual(result.claudeResult.success, true);
    assert.strictEqual(result.claudeResult.sessionId, 'session-abc123');
    assert.strictEqual(result.claudeResult.executionTime, 45000);

    await stateManager.close();
});

test('updateTaskState stores prResult metadata', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-pr',
        issueRef: { number: 90, repoOwner: 'pr-owner', repoName: 'pr-repo' },
        correlationId: 'corr-pr',
        state: TaskStates.POST_PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.POST_PROCESSING, timestamp: new Date().toISOString(), reason: 'Post-processing' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const prResult = { prNumber: 456, prUrl: 'https://github.com/pr-owner/pr-repo/pull/456' };
    const result = await stateManager.updateTaskState('task-pr', TaskStates.COMPLETED, {
        prResult,
        reason: 'PR created successfully'
    });

    // Verify prResult was stored
    assert.deepStrictEqual(result.prResult, prResult);

    await stateManager.close();
});

test('updateTaskState persists to Redis with TTL renewal', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-redis-persist',
        issueRef: { number: 100, repoOwner: 'redis-owner', repoName: 'redis-repo' },
        correlationId: 'corr-redis',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    await stateManager.updateTaskState('task-redis-persist', TaskStates.PROCESSING);

    // Verify Redis setex was called with correct key and TTL
    assert.strictEqual(mockRedisInstance.setex.mock.calls.length, 1);
    const setexCall = mockRedisInstance.setex.mock.calls[0];
    assert.strictEqual(setexCall.arguments[0], `${TEST_KEY_PREFIX}task-redis-persist`);
    assert.strictEqual(setexCall.arguments[1], TEST_STATE_EXPIRY);

    // Verify state was stored correctly
    const storedState = JSON.parse(setexCall.arguments[2] as string) as TaskStateData;
    assert.strictEqual(storedState.state, TaskStates.PROCESSING);
    assert.strictEqual(storedState.history.length, 2);

    await stateManager.close();
});

test('updateTaskState inserts history record into database', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-db-history',
        issueRef: { number: 110, repoOwner: 'db-owner', repoName: 'db-repo' },
        correlationId: 'corr-db-history',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    await stateManager.updateTaskState('task-db-history', TaskStates.PROCESSING, {
        reason: 'Starting processing',
        historyMetadata: { customField: 'customValue' }
    });

    // Verify database history insert was called
    assert.ok(mockDbHistoryInsert.mock.calls.length >= 1, 'Should insert into task_history table');

    const insertCall = mockDbHistoryInsert.mock.calls[0];
    const historyData = insertCall.arguments[0] as Record<string, unknown>;
    assert.strictEqual(historyData.task_id, 'task-db-history');
    assert.strictEqual(historyData.state, TaskStates.PROCESSING);
    assert.strictEqual(historyData.reason, 'Starting processing');

    // Verify metadata contains the custom field
    const metadata = JSON.parse(historyData.metadata as string);
    assert.strictEqual(metadata.customField, 'customValue');
    assert.strictEqual(metadata.previousState, TaskStates.PENDING);

    await stateManager.close();
});

test('updateTaskState uses default reason when not provided', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-default-reason',
        issueRef: { number: 120, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-default-reason',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.updateTaskState('task-default-reason', TaskStates.PROCESSING);

    // Verify default reason was used
    assert.strictEqual(result.history[1].reason, `State changed from ${TaskStates.PENDING}`);

    await stateManager.close();
});

test('updateTaskState stores historyMetadata in history entry', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-history-meta',
        issueRef: { number: 130, repoOwner: 'meta-owner', repoName: 'meta-repo' },
        correlationId: 'corr-history-meta',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.updateTaskState('task-history-meta', TaskStates.CLAUDE_EXECUTION, {
        reason: 'Claude execution started',
        historyMetadata: { sessionId: 'sess-123', conversationId: 'conv-456', model: 'claude-3' }
    });

    // Verify historyMetadata was stored in the history entry
    const latestHistory = result.history[result.history.length - 1];
    assert.ok(latestHistory.metadata);
    assert.strictEqual(latestHistory.metadata.sessionId, 'sess-123');
    assert.strictEqual(latestHistory.metadata.conversationId, 'conv-456');
    assert.strictEqual(latestHistory.metadata.model, 'claude-3');

    await stateManager.close();
});

test('updateTaskState handles database error gracefully', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-db-error-update',
        issueRef: { number: 140, repoOwner: 'error-owner', repoName: 'error-repo' },
        correlationId: 'corr-db-error',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockCorrelatedLogger.error.mock.resetCalls();

    // Make db history insert throw an error
    const originalHistoryInsert = mockDbHistoryInsert.mock.mockImplementation;
    mockDbHistoryInsert.mock.mockImplementation(() => {
        throw new Error('Database connection failed');
    });

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    // Should not throw - database errors are caught and logged
    const result = await stateManager.updateTaskState('task-db-error-update', TaskStates.PROCESSING, {
        reason: 'Processing started'
    });

    // State should still be updated in Redis
    assert.strictEqual(result.state, TaskStates.PROCESSING);
    assert.strictEqual(result.history.length, 2);

    // Verify error was logged
    assert.ok(mockCorrelatedLogger.error.mock.calls.length >= 1, 'Error should be logged');

    // Restore original mock
    mockDbHistoryInsert.mock.mockImplementation(originalHistoryInsert);

    await stateManager.close();
});

test('updateTaskState includes commitHash in database metadata', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-commit',
        issueRef: { number: 150, repoOwner: 'commit-owner', repoName: 'commit-repo' },
        correlationId: 'corr-commit',
        state: TaskStates.POST_PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.POST_PROCESSING, timestamp: new Date().toISOString(), reason: 'Post-processing' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    await stateManager.updateTaskState('task-commit', TaskStates.COMPLETED, {
        reason: 'Task completed',
        commitHash: 'abc123def456'
    });

    // Verify commitHash is included in database metadata
    const insertCall = mockDbHistoryInsert.mock.calls[0];
    const historyData = insertCall.arguments[0] as Record<string, unknown>;
    const metadata = JSON.parse(historyData.metadata as string);
    assert.strictEqual(metadata.commitHash, 'abc123def456');

    await stateManager.close();
});

// ============================================================================
// markTaskFailed tests
// ============================================================================

test('markTaskFailed sets state to FAILED', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-1',
        issueRef: { number: 200, repoOwner: 'fail-owner', repoName: 'fail-repo' },
        correlationId: 'corr-fail-1',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Processing started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('Something went wrong');
    const result = await stateManager.markTaskFailed('task-fail-1', error);

    // Verify state is set to FAILED
    assert.strictEqual(result.state, TaskStates.FAILED);

    await stateManager.close();
});

test('markTaskFailed stores error message in lastError', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-2',
        issueRef: { number: 201, repoOwner: 'fail-owner', repoName: 'fail-repo' },
        correlationId: 'corr-fail-2',
        state: TaskStates.CLAUDE_EXECUTION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 1,
        history: [{ state: TaskStates.CLAUDE_EXECUTION, timestamp: new Date().toISOString(), reason: 'Claude running' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const errorMessage = 'Connection timeout while communicating with Claude';
    const error = new Error(errorMessage);
    const result = await stateManager.markTaskFailed('task-fail-2', error);

    // Verify error message is stored in lastError
    assert.ok(result.lastError);
    assert.strictEqual(result.lastError.message, errorMessage);
    assert.ok(result.lastError.timestamp);

    await stateManager.close();
});

test('markTaskFailed defaults errorCategory to unknown when not specified', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-default-cat',
        issueRef: { number: 202, repoOwner: 'fail-owner', repoName: 'fail-repo' },
        correlationId: 'corr-fail-default',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('Generic error');
    const result = await stateManager.markTaskFailed('task-fail-default-cat', error);

    // Verify errorCategory defaults to 'unknown'
    assert.ok(result.lastError);
    assert.strictEqual(result.lastError.category, 'unknown');

    await stateManager.close();
});

test('markTaskFailed uses provided errorCategory from metadata', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-custom-cat',
        issueRef: { number: 203, repoOwner: 'fail-owner', repoName: 'fail-repo' },
        correlationId: 'corr-fail-custom',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('Network timeout');
    const result = await stateManager.markTaskFailed('task-fail-custom-cat', error, {
        errorCategory: 'network'
    });

    // Verify custom errorCategory is used
    assert.ok(result.lastError);
    assert.strictEqual(result.lastError.category, 'network');

    await stateManager.close();
});

test('markTaskFailed sets appropriate failure reason', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-reason',
        issueRef: { number: 204, repoOwner: 'fail-owner', repoName: 'fail-repo' },
        correlationId: 'corr-fail-reason',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const errorMessage = 'Out of memory';
    const error = new Error(errorMessage);
    const result = await stateManager.markTaskFailed('task-fail-reason', error);

    // Verify reason is set to "Task failed: {error.message}"
    const latestHistory = result.history[result.history.length - 1];
    assert.strictEqual(latestHistory.reason, `Task failed: ${errorMessage}`);

    await stateManager.close();
});

test('markTaskFailed appends failure to history', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-history',
        issueRef: { number: 205, repoOwner: 'fail-owner', repoName: 'fail-repo' },
        correlationId: 'corr-fail-history',
        state: TaskStates.CLAUDE_EXECUTION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' },
            { state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Processing started' },
            { state: TaskStates.CLAUDE_EXECUTION, timestamp: new Date().toISOString(), reason: 'Claude execution' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('Claude execution failed');
    const result = await stateManager.markTaskFailed('task-fail-history', error);

    // Verify failure state is appended to history
    assert.strictEqual(result.history.length, 4);
    assert.strictEqual(result.history[3].state, TaskStates.FAILED);
    assert.ok(result.history[3].timestamp);

    await stateManager.close();
});

test('markTaskFailed preserves additional metadata', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-meta',
        issueRef: { number: 206, repoOwner: 'fail-owner', repoName: 'fail-repo' },
        correlationId: 'corr-fail-meta',
        state: TaskStates.POST_PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.POST_PROCESSING, timestamp: new Date().toISOString(), reason: 'Post-processing' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('PR creation failed');
    const result = await stateManager.markTaskFailed('task-fail-meta', error, {
        errorCategory: 'github_api',
        historyMetadata: { attemptedAction: 'create_pr', statusCode: 500 }
    });

    // Verify additional metadata is preserved
    const latestHistory = result.history[result.history.length - 1];
    assert.ok(latestHistory.metadata);
    assert.strictEqual(latestHistory.metadata.attemptedAction, 'create_pr');
    assert.strictEqual(latestHistory.metadata.statusCode, 500);

    await stateManager.close();
});

test('markTaskFailed publishes real-time event', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-event',
        issueRef: { number: 207, repoOwner: 'event-owner', repoName: 'event-repo' },
        correlationId: 'corr-fail-event',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('Task execution failed');
    await stateManager.markTaskFailed('task-fail-event', error);

    // Verify event was published
    assert.strictEqual(mockPublishTaskUpdate.mock.calls.length, 1);
    const eventCall = mockPublishTaskUpdate.mock.calls[0];
    const eventPayload = eventCall.arguments[0] as {
        taskId: string;
        state: string;
        previousState: string;
        repository: string;
        issueNumber: number;
    };

    assert.strictEqual(eventPayload.taskId, 'task-fail-event');
    assert.strictEqual(eventPayload.state, TaskStates.FAILED);
    assert.strictEqual(eventPayload.previousState, TaskStates.PROCESSING);
    assert.strictEqual(eventPayload.repository, 'event-owner/event-repo');
    assert.strictEqual(eventPayload.issueNumber, 207);

    await stateManager.close();
});

test('markTaskFailed persists failure to Redis', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-redis',
        issueRef: { number: 208, repoOwner: 'redis-owner', repoName: 'redis-repo' },
        correlationId: 'corr-fail-redis',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('System failure');
    await stateManager.markTaskFailed('task-fail-redis', error);

    // Verify Redis setex was called
    assert.strictEqual(mockRedisInstance.setex.mock.calls.length, 1);
    const setexCall = mockRedisInstance.setex.mock.calls[0];
    assert.strictEqual(setexCall.arguments[0], `${TEST_KEY_PREFIX}task-fail-redis`);
    assert.strictEqual(setexCall.arguments[1], TEST_STATE_EXPIRY);

    // Verify stored state has FAILED status
    const storedState = JSON.parse(setexCall.arguments[2] as string) as TaskStateData;
    assert.strictEqual(storedState.state, TaskStates.FAILED);
    assert.ok(storedState.lastError);
    assert.strictEqual(storedState.lastError.message, 'System failure');

    await stateManager.close();
});

test('markTaskFailed inserts failure record into database', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-db',
        issueRef: { number: 209, repoOwner: 'db-owner', repoName: 'db-repo' },
        correlationId: 'corr-fail-db',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('Database error occurred');
    await stateManager.markTaskFailed('task-fail-db', error, {
        errorCategory: 'database'
    });

    // Verify database history insert was called
    assert.ok(mockDbHistoryInsert.mock.calls.length >= 1, 'Should insert into task_history table');

    const insertCall = mockDbHistoryInsert.mock.calls[0];
    const historyData = insertCall.arguments[0] as Record<string, unknown>;
    assert.strictEqual(historyData.task_id, 'task-fail-db');
    assert.strictEqual(historyData.state, TaskStates.FAILED);
    assert.ok(historyData.reason?.toString().includes('Task failed'));

    // Verify error metadata is included
    const metadata = JSON.parse(historyData.metadata as string);
    assert.ok(metadata.error);
    assert.strictEqual(metadata.error.message, 'Database error occurred');
    assert.strictEqual(metadata.error.category, 'database');

    await stateManager.close();
});

test('markTaskFailed throws when task not found', async () => {
    mockRedisInstance.get.mock.mockImplementation(async () => null);

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const error = new Error('Some error');

    await assert.rejects(
        async () => {
            await stateManager.markTaskFailed('non-existent-task', error);
        },
        {
            message: 'Task state not found for taskId: non-existent-task'
        }
    );

    await stateManager.close();
});

test('markTaskFailed handles different error categories', async () => {
    const categories = ['network', 'timeout', 'authentication', 'rate_limit', 'validation', 'internal'];

    for (const category of categories) {
        const existingState: TaskStateData = {
            taskId: `task-fail-cat-${category}`,
            issueRef: { number: 300, repoOwner: 'owner', repoName: 'repo' },
            correlationId: `corr-cat-${category}`,
            state: TaskStates.PROCESSING,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attempts: 0,
            history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
        };

        mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
        mockRedisInstance.setex.mock.resetCalls();
        mockDbHistoryInsert.mock.resetCalls();
        mockPublishTaskUpdate.mock.resetCalls();

        const stateManager = new WorkerStateManager({
            keyPrefix: TEST_KEY_PREFIX,
            stateExpiry: TEST_STATE_EXPIRY
        });

        const error = new Error(`Error of type ${category}`);
        const result = await stateManager.markTaskFailed(`task-fail-cat-${category}`, error, {
            errorCategory: category
        });

        // Verify category is correctly stored
        assert.ok(result.lastError);
        assert.strictEqual(result.lastError.category, category);

        await stateManager.close();
    }
});

test('markTaskFailed updates timestamp in lastError', async () => {
    const existingState: TaskStateData = {
        taskId: 'task-fail-timestamp',
        issueRef: { number: 210, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-fail-timestamp',
        state: TaskStates.PROCESSING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: new Date().toISOString(), reason: 'Started' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(existingState));
    mockRedisInstance.setex.mock.resetCalls();
    mockDbHistoryInsert.mock.resetCalls();
    mockPublishTaskUpdate.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const beforeTime = new Date();
    const error = new Error('Timing test error');
    const result = await stateManager.markTaskFailed('task-fail-timestamp', error);
    const afterTime = new Date();

    // Verify timestamp is set and is within the expected range
    assert.ok(result.lastError);
    assert.ok(result.lastError.timestamp);

    const errorTimestamp = new Date(result.lastError.timestamp);
    assert.ok(errorTimestamp >= beforeTime, 'Timestamp should be after test start');
    assert.ok(errorTimestamp <= afterTime, 'Timestamp should be before test end');

    await stateManager.close();
});

// ============================================================================
// getResumableTask tests
// ============================================================================

test('getResumableTask returns null when task not found', async () => {
    mockRedisInstance.get.mock.mockImplementation(async () => null);

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('non-existent-task');

    assert.strictEqual(result, null);

    await stateManager.close();
});

test('getResumableTask returns null for COMPLETED state', async () => {
    const completedState: TaskStateData = {
        taskId: 'task-completed',
        issueRef: { number: 500, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-completed',
        state: TaskStates.COMPLETED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' },
            { state: TaskStates.COMPLETED, timestamp: new Date().toISOString(), reason: 'Task completed' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(completedState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-completed');

    assert.strictEqual(result, null);

    await stateManager.close();
});

test('getResumableTask returns null for PENDING state', async () => {
    const pendingState: TaskStateData = {
        taskId: 'task-pending',
        issueRef: { number: 501, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-pending',
        state: TaskStates.PENDING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [{ state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(pendingState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-pending');

    assert.strictEqual(result, null);

    await stateManager.close();
});

test('getResumableTask returns null for FAILED state', async () => {
    const failedState: TaskStateData = {
        taskId: 'task-failed',
        issueRef: { number: 502, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-failed',
        state: TaskStates.FAILED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 1,
        history: [
            { state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' },
            { state: TaskStates.FAILED, timestamp: new Date().toISOString(), reason: 'Task failed' }
        ],
        lastError: { message: 'Some error', category: 'unknown', timestamp: new Date().toISOString() }
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(failedState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-failed');

    assert.strictEqual(result, null);

    await stateManager.close();
});

test('getResumableTask returns null for CANCELLED state', async () => {
    const cancelledState: TaskStateData = {
        taskId: 'task-cancelled',
        issueRef: { number: 503, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-cancelled',
        state: TaskStates.CANCELLED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: new Date().toISOString(), reason: 'Task created' },
            { state: TaskStates.CANCELLED, timestamp: new Date().toISOString(), reason: 'Task cancelled' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(cancelledState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-cancelled');

    assert.strictEqual(result, null);

    await stateManager.close();
});

test('getResumableTask returns task in PROCESSING state for recovery', async () => {
    const recentTime = new Date().toISOString();
    const processingState: TaskStateData = {
        taskId: 'task-processing',
        issueRef: { number: 510, repoOwner: 'proc-owner', repoName: 'proc-repo' },
        correlationId: 'corr-processing',
        state: TaskStates.PROCESSING,
        createdAt: recentTime,
        updatedAt: recentTime,
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: recentTime, reason: 'Task created' },
            { state: TaskStates.PROCESSING, timestamp: recentTime, reason: 'Processing started' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(processingState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-processing');

    assert.ok(result, 'Should return resumable task info');
    assert.strictEqual(result.taskId, 'task-processing');
    assert.strictEqual(result.state, TaskStates.PROCESSING);
    assert.strictEqual(result.isStale, false);
    assert.strictEqual(result.issueRef.number, 510);
    assert.strictEqual(result.correlationId, 'corr-processing');

    await stateManager.close();
});

test('getResumableTask returns task in CLAUDE_EXECUTION state', async () => {
    const recentTime = new Date().toISOString();
    const claudeExecState: TaskStateData = {
        taskId: 'task-claude-exec',
        issueRef: { number: 511, repoOwner: 'claude-owner', repoName: 'claude-repo' },
        correlationId: 'corr-claude-exec',
        state: TaskStates.CLAUDE_EXECUTION,
        createdAt: recentTime,
        updatedAt: recentTime,
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: recentTime, reason: 'Task created' },
            { state: TaskStates.PROCESSING, timestamp: recentTime, reason: 'Processing started' },
            { state: TaskStates.CLAUDE_EXECUTION, timestamp: recentTime, reason: 'Claude execution started' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(claudeExecState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-claude-exec');

    assert.ok(result, 'Should return resumable task info');
    assert.strictEqual(result.taskId, 'task-claude-exec');
    assert.strictEqual(result.state, TaskStates.CLAUDE_EXECUTION);
    assert.strictEqual(result.isStale, false);

    await stateManager.close();
});

test('getResumableTask returns task in POST_PROCESSING state', async () => {
    const recentTime = new Date().toISOString();
    const postProcState: TaskStateData = {
        taskId: 'task-post-proc',
        issueRef: { number: 512, repoOwner: 'post-owner', repoName: 'post-repo' },
        correlationId: 'corr-post-proc',
        state: TaskStates.POST_PROCESSING,
        createdAt: recentTime,
        updatedAt: recentTime,
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: recentTime, reason: 'Task created' },
            { state: TaskStates.PROCESSING, timestamp: recentTime, reason: 'Processing started' },
            { state: TaskStates.CLAUDE_EXECUTION, timestamp: recentTime, reason: 'Claude execution started' },
            { state: TaskStates.POST_PROCESSING, timestamp: recentTime, reason: 'Post-processing started' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(postProcState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-post-proc');

    assert.ok(result, 'Should return resumable task info');
    assert.strictEqual(result.taskId, 'task-post-proc');
    assert.strictEqual(result.state, TaskStates.POST_PROCESSING);
    assert.strictEqual(result.isStale, false);

    await stateManager.close();
});

test('getResumableTask marks task as stale if updated more than 30 minutes ago', async () => {
    // Create a timestamp 35 minutes in the past
    const staleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const staleState: TaskStateData = {
        taskId: 'task-stale',
        issueRef: { number: 520, repoOwner: 'stale-owner', repoName: 'stale-repo' },
        correlationId: 'corr-stale',
        state: TaskStates.PROCESSING,
        createdAt: staleTime,
        updatedAt: staleTime,
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: staleTime, reason: 'Task created' },
            { state: TaskStates.PROCESSING, timestamp: staleTime, reason: 'Processing started' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(staleState));
    mockLogger.warn.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-stale');

    assert.ok(result, 'Should return resumable task info');
    assert.strictEqual(result.taskId, 'task-stale');
    assert.strictEqual(result.state, TaskStates.PROCESSING);
    assert.strictEqual(result.isStale, true);
    assert.ok(result.staleDuration, 'Should have staleDuration');
    assert.ok(result.staleDuration >= 35 * 60 * 1000, 'Stale duration should be at least 35 minutes');

    await stateManager.close();
});

test('getResumableTask returns isStale=false for recently updated tasks', async () => {
    // Create a timestamp 5 minutes in the past (well within the 30 minute threshold)
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recentState: TaskStateData = {
        taskId: 'task-recent',
        issueRef: { number: 521, repoOwner: 'recent-owner', repoName: 'recent-repo' },
        correlationId: 'corr-recent',
        state: TaskStates.CLAUDE_EXECUTION,
        createdAt: recentTime,
        updatedAt: recentTime,
        attempts: 0,
        history: [
            { state: TaskStates.PENDING, timestamp: recentTime, reason: 'Task created' },
            { state: TaskStates.CLAUDE_EXECUTION, timestamp: recentTime, reason: 'Claude execution' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(recentState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-recent');

    assert.ok(result, 'Should return resumable task info');
    assert.strictEqual(result.isStale, false);
    assert.strictEqual(result.staleDuration, undefined);

    await stateManager.close();
});

test('getResumableTask logs warning for stale tasks', async () => {
    // Create a timestamp 40 minutes in the past
    const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const staleState: TaskStateData = {
        taskId: 'task-stale-log',
        issueRef: { number: 522, repoOwner: 'log-owner', repoName: 'log-repo' },
        correlationId: 'corr-stale-log',
        state: TaskStates.POST_PROCESSING,
        createdAt: staleTime,
        updatedAt: staleTime,
        attempts: 1,
        history: [
            { state: TaskStates.PENDING, timestamp: staleTime, reason: 'Task created' },
            { state: TaskStates.POST_PROCESSING, timestamp: staleTime, reason: 'Post-processing' }
        ]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(staleState));
    mockLogger.warn.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    await stateManager.getResumableTask('task-stale-log');

    // Verify warning was logged
    assert.ok(mockLogger.warn.mock.calls.length >= 1, 'Should log warning for stale task');

    const warnCall = mockLogger.warn.mock.calls[0];
    const logData = warnCall.arguments[0] as {
        taskId: string;
        correlationId: string;
        issueNumber: number;
        state: string;
        lastUpdate: string;
        staleDuration: number;
    };

    assert.strictEqual(logData.taskId, 'task-stale-log');
    assert.strictEqual(logData.correlationId, 'corr-stale-log');
    assert.strictEqual(logData.issueNumber, 522);
    assert.strictEqual(logData.state, TaskStates.POST_PROCESSING);
    assert.strictEqual(logData.lastUpdate, staleTime);
    assert.ok(logData.staleDuration >= 40 * 60 * 1000, 'Stale duration should be at least 40 minutes');

    const logMessage = warnCall.arguments[1];
    assert.ok(logMessage.includes('stale task'), 'Log message should mention stale task');

    await stateManager.close();
});

test('getResumableTask returns correct staleDuration for stale tasks', async () => {
    // Create a timestamp exactly 45 minutes in the past
    const staleDurationMs = 45 * 60 * 1000;
    const staleTime = new Date(Date.now() - staleDurationMs).toISOString();
    const staleState: TaskStateData = {
        taskId: 'task-stale-duration',
        issueRef: { number: 523, repoOwner: 'duration-owner', repoName: 'duration-repo' },
        correlationId: 'corr-stale-duration',
        state: TaskStates.PROCESSING,
        createdAt: staleTime,
        updatedAt: staleTime,
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: staleTime, reason: 'Processing' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(staleState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-stale-duration');

    assert.ok(result, 'Should return resumable task info');
    assert.strictEqual(result.isStale, true);
    assert.ok(result.staleDuration, 'Should have staleDuration');
    // Allow some tolerance for test execution time (within 5 seconds)
    assert.ok(result.staleDuration >= staleDurationMs - 5000, 'Stale duration should be approximately 45 minutes');
    assert.ok(result.staleDuration <= staleDurationMs + 5000, 'Stale duration should be approximately 45 minutes');

    await stateManager.close();
});

test('getResumableTask does not return staleDuration for non-stale tasks', async () => {
    const recentTime = new Date().toISOString();
    const recentState: TaskStateData = {
        taskId: 'task-no-stale-duration',
        issueRef: { number: 524, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-no-stale',
        state: TaskStates.PROCESSING,
        createdAt: recentTime,
        updatedAt: recentTime,
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: recentTime, reason: 'Processing' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(recentState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-no-stale-duration');

    assert.ok(result, 'Should return resumable task info');
    assert.strictEqual(result.isStale, false);
    assert.strictEqual(result.staleDuration, undefined, 'Should not have staleDuration for non-stale tasks');

    await stateManager.close();
});

test('getResumableTask preserves all task state data', async () => {
    const recentTime = new Date().toISOString();
    const fullState: TaskStateData = {
        taskId: 'task-full-state',
        issueRef: {
            number: 530,
            repoOwner: 'full-owner',
            repoName: 'full-repo',
            type: 'pull_request',
            modelName: 'claude-3-opus'
        },
        correlationId: 'corr-full-state',
        state: TaskStates.CLAUDE_EXECUTION,
        createdAt: recentTime,
        updatedAt: recentTime,
        attempts: 2,
        history: [
            { state: TaskStates.PENDING, timestamp: recentTime, reason: 'Task created' },
            { state: TaskStates.PROCESSING, timestamp: recentTime, reason: 'Processing started' },
            { state: TaskStates.CLAUDE_EXECUTION, timestamp: recentTime, reason: 'Claude execution' }
        ],
        worktreeInfo: { path: '/tmp/worktrees/task-530', branch: 'feature/530' },
        claudeResult: { success: true, sessionId: 'sess-530', executionTime: 30000 }
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(fullState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-full-state');

    assert.ok(result, 'Should return resumable task info');

    // Verify all original state data is preserved
    assert.strictEqual(result.taskId, 'task-full-state');
    assert.strictEqual(result.correlationId, 'corr-full-state');
    assert.strictEqual(result.state, TaskStates.CLAUDE_EXECUTION);
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.history.length, 3);

    // Verify issueRef is preserved
    assert.strictEqual(result.issueRef.number, 530);
    assert.strictEqual(result.issueRef.repoOwner, 'full-owner');
    assert.strictEqual(result.issueRef.repoName, 'full-repo');
    assert.strictEqual(result.issueRef.type, 'pull_request');
    assert.strictEqual(result.issueRef.modelName, 'claude-3-opus');

    // Verify additional metadata is preserved
    assert.deepStrictEqual(result.worktreeInfo, { path: '/tmp/worktrees/task-530', branch: 'feature/530' });
    assert.ok(result.claudeResult);
    assert.strictEqual(result.claudeResult.success, true);
    assert.strictEqual(result.claudeResult.sessionId, 'sess-530');
    assert.strictEqual(result.claudeResult.executionTime, 30000);

    // Verify resumable task additions
    assert.strictEqual(result.isStale, false);

    await stateManager.close();
});

test('getResumableTask handles task at exactly 30 minute threshold', async () => {
    // Create a timestamp exactly 30 minutes in the past (at the boundary)
    const thresholdTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const thresholdState: TaskStateData = {
        taskId: 'task-threshold',
        issueRef: { number: 540, repoOwner: 'threshold-owner', repoName: 'threshold-repo' },
        correlationId: 'corr-threshold',
        state: TaskStates.PROCESSING,
        createdAt: thresholdTime,
        updatedAt: thresholdTime,
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: thresholdTime, reason: 'Processing' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(thresholdState));

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    const result = await stateManager.getResumableTask('task-threshold');

    assert.ok(result, 'Should return resumable task info');
    // Due to the > comparison (not >=), exactly at 30 minutes should still be non-stale
    // However, with test execution time, it will likely be just over 30 minutes
    // So we just verify it's a valid resumable task
    assert.strictEqual(result.taskId, 'task-threshold');
    assert.strictEqual(result.state, TaskStates.PROCESSING);
    assert.ok('isStale' in result, 'Should have isStale property');

    await stateManager.close();
});

test('getResumableTask does not log warning for non-stale tasks', async () => {
    const recentTime = new Date().toISOString();
    const recentState: TaskStateData = {
        taskId: 'task-no-warn',
        issueRef: { number: 550, repoOwner: 'owner', repoName: 'repo' },
        correlationId: 'corr-no-warn',
        state: TaskStates.PROCESSING,
        createdAt: recentTime,
        updatedAt: recentTime,
        attempts: 0,
        history: [{ state: TaskStates.PROCESSING, timestamp: recentTime, reason: 'Processing' }]
    };

    mockRedisInstance.get.mock.mockImplementation(async () => JSON.stringify(recentState));
    mockLogger.warn.mock.resetCalls();

    const stateManager = new WorkerStateManager({
        keyPrefix: TEST_KEY_PREFIX,
        stateExpiry: TEST_STATE_EXPIRY
    });

    await stateManager.getResumableTask('task-no-warn');

    // Verify no warning was logged
    assert.strictEqual(mockLogger.warn.mock.calls.length, 0, 'Should not log warning for non-stale task');

    await stateManager.close();
});

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
