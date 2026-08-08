import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import {
    TaskStates,
    type TaskStateData,
    type TaskStateExpectation,
} from '../packages/core/src/utils/workerStateManager.types.js';

function expectationFor(task: TaskStateData): TaskStateExpectation {
    return {
        state: task.state,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        correlationId: task.correlationId,
        version: task.version,
    };
}

const finalizeCompletedPRCommentTask = mock.fn(async () => ({
    outcome: 'finalized' as const,
    stateChanged: true,
}));
const finalizeFailedPRCommentTask = mock.fn(async () => ({
    outcome: 'finalized' as const,
    stateChanged: true,
}));

await mock.module('../src/jobs/prCommentTaskFinalizer.js', {
    namedExports: {
        finalizeCompletedPRCommentTask,
        finalizeFailedPRCommentTask,
    },
});
await mock.module('@propr/core', {
    namedExports: {
        executeDockerCommand: mock.fn(),
        logger: {
            error: mock.fn(),
            warn: mock.fn(),
        },
        taskStateExpectation: expectationFor,
    },
});

const {
    inspectLegacyTaskContainerLiveness,
    reconcileStalePRCommentTasks,
    taskAgeMs,
} = await import('../src/taskStateReconciler.js');

const NOW = Date.parse('2026-08-05T12:00:00.000Z');

function makeTask(
    taskId: string,
    overrides: Partial<TaskStateData> = {},
): TaskStateData {
    return {
        taskId,
        issueRef: {
            type: 'pr_comment',
            number: 1748,
            repoOwner: 'integry',
            repoName: 'propr',
            comments: [{ id: 1, body: '/fix' }],
        },
        correlationId: `correlation-${taskId}`,
        state: TaskStates.PROCESSING,
        createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
        attempts: 1,
        history: [],
        ...overrides,
    };
}

function createStateManager(tasks: TaskStateData[]) {
    return {
        scanNonTerminalTasks: mock.fn(async () => ({ tasks, nextCursor: '17' })),
        getTaskState: mock.fn(),
        updateTaskStateIfCurrentDetailed: mock.fn(),
    };
}

beforeEach(() => {
    finalizeCompletedPRCommentTask.mock.resetCalls();
    finalizeFailedPRCommentTask.mock.resetCalls();
});

test('recovers completed and failed BullMQ outcomes through the shared finalizer', async () => {
    const completed = makeTask('pr-comments-completed');
    const failed = makeTask('pr-comments-failed');
    const jobs = new Map([
        [completed.taskId, {
            returnvalue: { status: 'complete' },
            getState: async () => 'completed',
        }],
        [failed.taskId, {
            failedReason: 'agent crashed',
            getState: async () => 'failed',
        }],
    ]);
    const result = await reconcileStalePRCommentTasks({
        queue: { getJob: async taskId => jobs.get(taskId) },
        stateManager: createStateManager([completed, failed]),
        now: NOW,
    });

    assert.equal(result.nextCursor, '17');
    assert.deepEqual(result.summary, {
        scanned: 2,
        stale: 2,
        live: 0,
        recovered: 2,
        skipped: 0,
        errors: 0,
    });
    assert.equal(finalizeCompletedPRCommentTask.mock.calls[0].arguments[1]?.status, 'complete');
    assert.match(finalizeFailedPRCommentTask.mock.calls[0].arguments[1].message, /agent crashed/);
    assert.deepEqual(
        finalizeCompletedPRCommentTask.mock.calls[0].arguments[3]?.expectation,
        expectationFor(completed),
    );
    assert.deepEqual(
        finalizeFailedPRCommentTask.mock.calls[0].arguments[3]?.expectation,
        expectationFor(failed),
    );
});

test('leaves live, recent, non-PR, and future-dated work untouched', async () => {
    const active = makeTask('pr-comments-active');
    const recent = makeTask('pr-comments-recent', {
        updatedAt: new Date(NOW - 1_000).toISOString(),
    });
    const issue = makeTask('issue-task', {
        issueRef: { type: 'issue', number: 1, repoOwner: 'integry', repoName: 'propr' },
    });
    const future = makeTask('pr-comments-future', {
        updatedAt: new Date(NOW + 60_000).toISOString(),
    });
    const result = await reconcileStalePRCommentTasks({
        queue: {
            getJob: async taskId => taskId === active.taskId
                ? { getState: async () => 'active' }
                : null,
        },
        stateManager: createStateManager([active, recent, issue, future]),
        now: NOW,
    });

    assert.equal(result.summary.live, 1);
    assert.equal(result.summary.recovered, 0);
    assert.equal(result.summary.skipped, 3);
    assert.equal(finalizeCompletedPRCommentTask.mock.calls.length, 0);
    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 0);
});

test('leaves an untyped issue task with comments untouched', async () => {
    const issue = makeTask('issue-task-with-comments', {
        issueRef: {
            number: 1,
            repoOwner: 'integry',
            repoName: 'propr',
            comments: [{ id: 1, body: 'Additional issue context' }],
        },
    });
    const queue = { getJob: mock.fn(async () => null) };
    const inspectContainer = mock.fn(async () => 'not_found' as const);
    const result = await reconcileStalePRCommentTasks({
        queue,
        stateManager: createStateManager([issue]),
        inspectContainer,
        now: NOW,
    });

    assert.deepEqual(result.summary, {
        scanned: 1,
        stale: 0,
        live: 0,
        recovered: 0,
        skipped: 1,
        errors: 0,
    });
    assert.equal(queue.getJob.mock.calls.length, 0);
    assert.equal(inspectContainer.mock.calls.length, 0);
    assert.equal(finalizeCompletedPRCommentTask.mock.calls.length, 0);
    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 0);
});

test('leaves future-dated work untouched when the stale threshold is zero', async () => {
    const future = makeTask('pr-comments-future-zero-threshold', {
        updatedAt: new Date(NOW + 60_000).toISOString(),
    });
    const queue = { getJob: mock.fn(async () => null) };
    const inspectContainer = mock.fn(async () => 'not_found' as const);
    const result = await reconcileStalePRCommentTasks({
        queue,
        stateManager: createStateManager([future]),
        inspectContainer,
        now: NOW,
        staleMs: 0,
    });

    assert.deepEqual(result.summary, {
        scanned: 1,
        stale: 0,
        live: 0,
        recovered: 0,
        skipped: 1,
        errors: 0,
    });
    assert.equal(queue.getJob.mock.calls.length, 0);
    assert.equal(inspectContainer.mock.calls.length, 0);
    assert.equal(finalizeCompletedPRCommentTask.mock.calls.length, 0);
    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 0);
});

test('fails an orphan only when Docker is available and no container is live', async () => {
    const orphan = makeTask('pr-comments-orphan');
    const unavailable = makeTask('pr-comments-unavailable');
    const running = makeTask('pr-comments-running');
    const result = await reconcileStalePRCommentTasks({
        queue: { getJob: async () => null },
        stateManager: createStateManager([orphan, unavailable, running]),
        inspectContainer: async taskId => {
            if (taskId === unavailable.taskId) return 'unavailable';
            if (taskId === running.taskId) return 'running';
            return 'not_found';
        },
        now: NOW,
    });

    assert.equal(result.summary.recovered, 1);
    assert.equal(result.summary.live, 1);
    assert.equal(result.summary.errors, 1);
    assert.equal(finalizeFailedPRCommentTask.mock.calls.length, 1);
    assert.match(
        finalizeFailedPRCommentTask.mock.calls[0].arguments[1].message,
        /outcome is unavailable/,
    );
});

test('isolates a task lookup failure and continues the scan', async () => {
    const broken = makeTask('pr-comments-broken');
    const completed = makeTask('pr-comments-after-error');
    const result = await reconcileStalePRCommentTasks({
        queue: {
            getJob: async taskId => {
                if (taskId === broken.taskId) throw new Error('Redis unavailable');
                return { returnvalue: { status: 'complete' }, getState: async () => 'completed' };
            },
        },
        stateManager: createStateManager([broken, completed]),
        now: NOW,
    });

    assert.equal(result.summary.errors, 1);
    assert.equal(result.summary.recovered, 1);
});

test('resumes the unprocessed part of a page before scanning the next cursor', async () => {
    const first = makeTask('pr-comments-first');
    const second = makeTask('pr-comments-second');
    const stateManager = createStateManager([first, second]);
    const budgetResult = await reconcileStalePRCommentTasks({
        queue: { getJob: async () => new Promise<never>(() => {}) },
        stateManager,
        now: NOW,
        timeBudgetMs: 10,
    });

    assert.deepEqual(budgetResult.backlog.map(task => task.taskId), [first.taskId, second.taskId]);
    assert.equal(budgetResult.summary.skipped, 0);

    const resumedResult = await reconcileStalePRCommentTasks({
        queue: {
            getJob: async () => ({
                returnvalue: { status: 'complete' },
                getState: async () => 'completed',
            }),
        },
        stateManager,
        cursor: budgetResult.nextCursor,
        backlog: budgetResult.backlog,
        now: NOW,
    });

    assert.deepEqual(resumedResult.backlog, []);
    assert.equal(resumedResult.summary.recovered, 2);
    assert.equal(stateManager.scanNonTerminalTasks.mock.calls.length, 1);
});

test('bounds the initial Redis scan by the reconciliation budget', async () => {
    const stateManager = createStateManager([]);
    stateManager.scanNonTerminalTasks.mock.mockImplementationOnce(
        async () => new Promise<never>(() => {}),
    );

    await assert.rejects(
        reconcileStalePRCommentTasks({
            queue: { getJob: async () => null },
            stateManager,
            timeBudgetMs: 10,
        }),
        /time budget was exhausted/,
    );
});

test('legacy container inspection is non-destructive and distinguishes Docker outages', async () => {
    const calls: string[][] = [];
    const running = await inspectLegacyTaskContainerLiveness(
        'pr-comments-special.[id]',
        async (_command, args) => {
            calls.push(args);
            return {
                stdout: 'container-id\n',
                stderr: '',
                exitCode: 0,
                messageTimestamps: new Map(),
            };
        },
    );
    const unavailable = await inspectLegacyTaskContainerLiveness(
        'pr-comments-special.[id]',
        async () => {
            throw new Error('Docker unavailable');
        },
    );

    assert.equal(running, 'running');
    assert.equal(unavailable, 'unavailable');
    assert.deepEqual(calls[0].slice(0, 3), ['ps', '--filter', 'name=ial\\.\\[id\\]$']);
    assert.equal(calls[0].includes('stop'), false);
    assert.equal(calls[0].includes('rm'), false);
});

test('invalid and future timestamps are not treated as stale', () => {
    assert.equal(taskAgeMs('not-a-date', NOW), null);
    assert.equal(taskAgeMs(new Date(NOW + 1_000).toISOString(), NOW), null);
});
