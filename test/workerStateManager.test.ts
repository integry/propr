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

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
