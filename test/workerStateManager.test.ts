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

// Force exit due to module-level initialization in @propr/core
after(() => {
    process.exit(0);
});
