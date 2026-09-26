import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    TaskStates,
    type TaskStateData,
    type TaskStateExpectation,
} from '../packages/core/src/utils/workerStateManager.types.js';
import type {
    MissingTaskObservation,
    PersistedTaskStateCandidate,
    PersistedTaskStateStore,
    PersistedTaskTerminalTransition,
} from '../src/persistedTaskStateStore.js';
import { taskAgeMs } from '../src/taskReconciliationTime.js';

function expectationFor(task: TaskStateData): TaskStateExpectation {
    return {
        state: task.state,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        correlationId: task.correlationId,
        version: task.version,
    };
}

async function inspectExactContainer(
    taskId: string,
    executor: (command: string, args: string[], options: { timeout: number }) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>,
) {
    try {
        const result = await executor('docker', [
            'ps', '-a', '--filter', `label=propr.task.id=${taskId}`, '--format', '{{.State}}',
        ], { timeout: 10_000 });
        if (result.exitCode !== 0) return { liveness: 'unavailable', container: null };
        return result.stdout.trim()
            ? { liveness: 'running', container: { id: 'id', name: 'name' } }
            : { liveness: 'not_found', container: null };
    } catch {
        return { liveness: 'unavailable', container: null };
    }
}

async function inspectLegacyContainer(
    taskId: string,
    executor: (command: string, args: string[], options: { timeout: number }) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>,
) {
    const suffix = taskId.slice(-8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        const result = await executor('docker', [
            'ps', '--filter', `name=${suffix}$`, '--format', '{{.ID}}:{{.Names}}',
        ], { timeout: 10_000 });
        if (result.exitCode !== 0) return 'unavailable';
        return result.stdout.trim() ? 'running' : 'not_found';
    } catch {
        return 'unavailable';
    }
}

await mock.module('@propr/core', {
    namedExports: {
        executeDockerCommand: mock.fn(),
        inspectTaskContainerLivenessForTask: inspectExactContainer,
        inspectLegacyDockerContainerLivenessForTask: inspectLegacyContainer,
        logger: { error: mock.fn(), warn: mock.fn() },
        taskStateExpectation: expectationFor,
        TaskStates,
    },
});

const {
    inspectLegacyTaskContainerLiveness,
    reconcileStaleTaskStates,
} = await import('../src/taskStateReconciler.js');

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const STALE_AT = new Date(NOW - 30 * 60 * 1000).toISOString();

function makeCandidate(
    taskId: string,
    overrides: Partial<PersistedTaskStateCandidate> = {},
): PersistedTaskStateCandidate {
    return {
        taskId,
        jobId: taskId,
        repository: 'integry/propr',
        issueNumber: 1748,
        taskType: 'issue',
        state: TaskStates.PROCESSING,
        updatedAt: STALE_AT,
        historyId: 17,
        ...overrides,
    };
}

function makeRedisState(
    candidate: PersistedTaskStateCandidate,
    overrides: Partial<TaskStateData> = {},
): TaskStateData {
    return {
        taskId: candidate.taskId,
        issueRef: {
            type: candidate.taskType ?? undefined,
            number: candidate.issueNumber ?? 0,
            repoOwner: 'integry',
            repoName: 'propr',
        },
        correlationId: `correlation-${candidate.taskId}`,
        state: candidate.state as TaskStateData['state'],
        createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
        updatedAt: String(candidate.updatedAt),
        version: 3,
        attempts: 1,
        history: [],
        ...overrides,
    };
}

function createStore(
    tasks: PersistedTaskStateCandidate[],
    observation: MissingTaskObservation = {
        observations: 1,
        firstMissingAt: new Date(NOW).toISOString(),
    },
) {
    const transitions: Array<{
        candidate: PersistedTaskStateCandidate;
        transition: PersistedTaskTerminalTransition;
    }> = [];
    const store: PersistedTaskStateStore = {
        scanNonTerminalTasks: mock.fn(async () => ({ tasks, nextCursor: '17' })),
        recordMissing: mock.fn(async () => observation),
        clearMissing: mock.fn(async () => {}),
        ownsJobAssignment: mock.fn(async () => true),
        finalizeIfCurrent: mock.fn(async (candidate, transition) => {
            transitions.push({ candidate, transition });
            return { stateChanged: true, eventPublished: true };
        }),
    };
    return { store, transitions };
}

function createStateManager(states: Map<string, TaskStateData> = new Map()) {
    return {
        getTaskState: mock.fn(async (taskId: string) => states.get(taskId) ?? null),
        updateTaskStateIfCurrentDetailed: mock.fn(async () => null),
    };
}

test('recovers completed and failed BullMQ outcomes for all durable task types', async () => {
    const completed = makeCandidate('issue-completed', { jobId: 'bull-101' });
    const failed = makeCandidate('task-import-failed', { jobId: 'bull-102', taskType: 'task-import' });
    const jobs = new Map([
        ['bull-101', {
            returnvalue: { status: 'complete' },
            getState: async () => 'completed',
        }],
        ['bull-102', {
            failedReason: 'agent crashed',
            getState: async () => 'failed',
        }],
    ]);
    const { store, transitions } = createStore([completed, failed]);
    const result = await reconcileStaleTaskStates({
        queue: { getJob: async jobId => jobs.get(jobId) },
        stateManager: createStateManager(),
        store,
        now: NOW,
    });

    assert.equal(result.nextCursor, '17');
    assert.deepEqual(result.summary, {
        scanned: 2,
        stale: 2,
        live: 0,
        suspected: 0,
        recovered: 2,
        skipped: 0,
        errors: 0,
    });
    assert.deepEqual(transitions.map(item => item.transition.state), [
        TaskStates.COMPLETED,
        TaskStates.FAILED,
    ]);
    assert.deepEqual(transitions.map(item => item.candidate.jobId), ['bull-101', 'bull-102']);
    assert.match(JSON.stringify(transitions[1].transition.metadata), /agent crashed/);
});

test('leaves live queue jobs, fresh Redis states, recent rows, and future rows untouched', async () => {
    const queued = makeCandidate('queued');
    const freshRedis = makeCandidate('fresh-redis');
    const recent = makeCandidate('recent', { updatedAt: new Date(NOW - 1_000).toISOString() });
    const future = makeCandidate('future', { updatedAt: new Date(NOW + 60_000).toISOString() });
    const redisState = makeRedisState(freshRedis, {
        updatedAt: new Date(NOW - 1_000).toISOString(),
    });
    const { store } = createStore([queued, freshRedis, recent, future]);
    const result = await reconcileStaleTaskStates({
        queue: {
            getJob: async jobId => jobId === queued.jobId
                ? { getState: async () => 'active' }
                : null,
        },
        stateManager: createStateManager(new Map([[freshRedis.taskId, redisState]])),
        store,
        now: NOW,
    });

    assert.deepEqual(result.summary, {
        scanned: 4,
        stale: 2,
        live: 2,
        suspected: 0,
        recovered: 0,
        skipped: 2,
        errors: 0,
    });
    assert.equal((store.clearMissing as ReturnType<typeof mock.fn>).mock.calls.length, 2);
    assert.equal((store.finalizeIfCurrent as ReturnType<typeof mock.fn>).mock.calls.length, 0);
});

test('requires two durable missing observations separated by the grace period', async () => {
    const orphan = makeCandidate('orphan');
    const first = createStore([orphan]);
    const firstResult = await reconcileStaleTaskStates({
        queue: { getJob: async () => null },
        stateManager: createStateManager(),
        store: first.store,
        inspectContainer: async () => 'not_found',
        now: NOW,
    });

    assert.equal(firstResult.summary.suspected, 1);
    assert.equal(firstResult.summary.recovered, 0);

    const second = createStore([orphan], {
        observations: 2,
        firstMissingAt: new Date(NOW - 60_000).toISOString(),
    });
    const secondResult = await reconcileStaleTaskStates({
        queue: { getJob: async () => null },
        stateManager: createStateManager(),
        store: second.store,
        inspectContainer: async () => 'not_found',
        now: NOW,
        orphanGraceMs: 60_000,
    });

    assert.equal(secondResult.summary.suspected, 0);
    assert.equal(secondResult.summary.recovered, 1);
    assert.equal(second.transitions[0].transition.state, TaskStates.FAILED);
    assert.match(JSON.stringify(second.transitions[0].transition.metadata), /orphaned after worker restart/);
});

test('does not count Docker outages as evidence that a task is orphaned', async () => {
    const candidate = makeCandidate('docker-unavailable');
    const { store } = createStore([candidate]);
    const result = await reconcileStaleTaskStates({
        queue: { getJob: async () => null },
        stateManager: createStateManager(),
        store,
        inspectContainer: async () => 'unavailable',
        now: NOW,
    });

    assert.equal(result.summary.errors, 1);
    assert.equal(result.summary.suspected, 0);
    assert.equal((store.recordMissing as ReturnType<typeof mock.fn>).mock.calls.length, 0);
});

test('defers legacy non-PR tasks through the Redis retention window', async () => {
    const candidate = makeCandidate('legacy-issue', { jobId: null });
    const { store } = createStore([candidate], {
        observations: 2,
        firstMissingAt: new Date(NOW - 60_000).toISOString(),
    });
    const result = await reconcileStaleTaskStates({
        queue: { getJob: async () => null },
        stateManager: createStateManager(),
        store,
        inspectContainer: async () => 'not_found',
        now: NOW,
    });

    assert.equal(result.summary.skipped, 1);
    assert.equal((store.recordMissing as ReturnType<typeof mock.fn>).mock.calls.length, 0);
});

test('reconciles legacy unlinked tasks after the Redis retention window', async () => {
    const candidate = makeCandidate('old-legacy-issue', {
        jobId: null,
        updatedAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const { store } = createStore([candidate], {
        observations: 2,
        firstMissingAt: new Date(NOW - 60_000).toISOString(),
    });
    const result = await reconcileStaleTaskStates({
        queue: { getJob: async () => null },
        stateManager: createStateManager(),
        store,
        inspectContainer: async () => 'not_found',
        now: NOW,
    });

    assert.equal(result.summary.recovered, 1);
});

test('persists a terminal Redis state that was missed by SQLite', async () => {
    const candidate = makeCandidate('redis-terminal');
    const terminal = makeRedisState(candidate, {
        state: TaskStates.COMPLETED,
        updatedAt: new Date(NOW - 1_000).toISOString(),
    });
    const { store, transitions } = createStore([candidate]);
    const result = await reconcileStaleTaskStates({
        queue: { getJob: async () => null },
        stateManager: createStateManager(new Map([[candidate.taskId, terminal]])),
        store,
        now: NOW,
    });

    assert.equal(result.summary.recovered, 1);
    assert.equal(transitions[0].transition.state, TaskStates.COMPLETED);
});

test('keeps a recovered Redis handoff cancellation identifiable as an operational handoff', async () => {
    const candidate = makeCandidate('redis-rescheduled', { taskType: 'pr-comment' });
    const handoffReason = 'Task job rescheduled: pr_locked_by_other_job';
    const terminal = makeRedisState(candidate, {
        state: TaskStates.CANCELLED,
        updatedAt: new Date(NOW - 1_000).toISOString(),
        history: [
            { state: TaskStates.PROCESSING, timestamp: STALE_AT, reason: 'Started', metadata: {} },
            {
                state: TaskStates.CANCELLED,
                timestamp: new Date(NOW - 1_000).toISOString(),
                reason: handoffReason,
                metadata: {
                    finalizedBy: 'bullmq_completed_reconciliation',
                    jobResultStatus: 'rescheduled',
                    jobResultReason: 'pr_locked_by_other_job',
                },
            },
        ],
    });
    const { store, transitions } = createStore([candidate]);
    const result = await reconcileStaleTaskStates({
        queue: { getJob: async () => null },
        stateManager: createStateManager(new Map([[candidate.taskId, terminal]])),
        store,
        now: NOW,
    });

    assert.equal(result.summary.recovered, 1);
    assert.equal(transitions[0].transition.state, TaskStates.CANCELLED);
    assert.equal(transitions[0].transition.reason, handoffReason);
    assert.equal(transitions[0].transition.metadata.jobResultStatus, 'rescheduled');
    assert.equal(transitions[0].transition.metadata.jobResultReason, 'pr_locked_by_other_job');
    assert.equal(transitions[0].transition.metadata.finalizedBy, 'redis_terminal_reconciliation');
    assert.equal(transitions[0].transition.metadata.originalFinalizedBy, 'bullmq_completed_reconciliation');
});

test('isolates a task lookup failure and continues the persisted scan', async () => {
    const broken = makeCandidate('broken');
    const completed = makeCandidate('after-error');
    const { store } = createStore([broken, completed]);
    const result = await reconcileStaleTaskStates({
        queue: {
            getJob: async jobId => {
                if (jobId === broken.jobId) throw new Error('Redis unavailable');
                return { returnvalue: { status: 'complete' }, getState: async () => 'completed' };
            },
        },
        stateManager: createStateManager(),
        store,
        now: NOW,
    });

    assert.equal(result.summary.errors, 1);
    assert.equal(result.summary.recovered, 1);
});

test('resumes the unprocessed part of a page before scanning another page', async () => {
    const first = makeCandidate('first');
    const second = makeCandidate('second');
    const created = createStore([first, second]);
    const budgetResult = await reconcileStaleTaskStates({
        queue: { getJob: async () => new Promise<never>(() => {}) },
        stateManager: createStateManager(),
        store: created.store,
        now: NOW,
        timeBudgetMs: 10,
    });

    assert.deepEqual(budgetResult.backlog.map(task => task.taskId), [first.taskId, second.taskId]);

    const resumedResult = await reconcileStaleTaskStates({
        queue: {
            getJob: async () => ({
                returnvalue: { status: 'complete' },
                getState: async () => 'completed',
            }),
        },
        stateManager: createStateManager(),
        store: created.store,
        cursor: budgetResult.nextCursor,
        backlog: budgetResult.backlog,
        now: NOW,
    });

    assert.deepEqual(resumedResult.backlog, []);
    assert.equal(resumedResult.summary.recovered, 2);
    assert.equal((created.store.scanNonTerminalTasks as ReturnType<typeof mock.fn>).mock.calls.length, 1);
});

for (const redisEntry of ['absent', 'stale'] as const) {
    test(`does not let a carried task adopt a reused job ID outcome when Redis state is ${redisEntry}`, async () => {
        const blocker = makeCandidate('blocker', { jobId: 'bull-blocker' });
        const abandoned = makeCandidate('abandoned', { jobId: 'issue-integry-propr-1748' });
        const created = createStore([blocker, abandoned]);
        const budgetResult = await reconcileStaleTaskStates({
            queue: { getJob: async () => new Promise<never>(() => {}) },
            stateManager: createStateManager(),
            store: created.store,
            now: NOW,
            timeBudgetMs: 10,
        });
        assert.deepEqual(budgetResult.backlog.map(task => task.taskId), [blocker.taskId, abandoned.taskId]);

        // Between runs a replacement task takes the reused job ID and completes.
        const assignments = new Map([
            [blocker.taskId, blocker.jobId],
            [abandoned.taskId, null as string | null],
        ]);
        (created.store.ownsJobAssignment as ReturnType<typeof mock.fn>).mock.mockImplementation(
            async (candidate: PersistedTaskStateCandidate) => assignments.get(candidate.taskId) === candidate.jobId,
        );
        const stateManager = createStateManager(redisEntry === 'stale'
            ? new Map([[abandoned.taskId, makeRedisState(abandoned)]])
            : new Map());
        const resumedResult = await reconcileStaleTaskStates({
            queue: {
                getJob: async (jobId: string) => jobId === abandoned.jobId
                    ? { returnvalue: { status: 'complete' }, getState: async () => 'completed' }
                    : null,
            },
            stateManager,
            store: created.store,
            cursor: budgetResult.nextCursor,
            backlog: budgetResult.backlog,
            now: NOW,
            inspectContainer: async () => 'not_found',
        });

        assert.deepEqual(resumedResult.backlog, []);
        assert.equal(resumedResult.summary.recovered, 0);
        assert.equal(created.transitions.some(entry => entry.candidate.taskId === abandoned.taskId), false);
        assert.equal(stateManager.updateTaskStateIfCurrentDetailed.mock.calls.length, 0);
    });
}

test('bounds the initial persisted scan by the reconciliation budget', async () => {
    const created = createStore([]);
    (created.store.scanNonTerminalTasks as ReturnType<typeof mock.fn>).mock.mockImplementationOnce(
        async () => new Promise<never>(() => {}),
    );

    await assert.rejects(
        reconcileStaleTaskStates({
            queue: { getJob: async () => null },
            stateManager: createStateManager(),
            store: created.store,
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
                stdout: args.includes('-a') ? '' : 'container-id\n',
                stderr: '',
                exitCode: 0,
                messageTimestamps: new Map(),
            };
        },
    );
    const unavailable = await inspectLegacyTaskContainerLiveness(
        'pr-comments-special.[id]',
        async () => { throw new Error('Docker unavailable'); },
    );

    assert.equal(running, 'running');
    assert.equal(unavailable, 'unavailable');
    assert.deepEqual(calls[1].slice(0, 3), ['ps', '--filter', 'name=ial\\\.\\[id\\]$']);
    assert.equal(calls.every(args => !args.includes('stop')), true);
    assert.equal(calls.every(args => !args.includes('rm')), true);
});

test('invalid, future, and numeric timestamps are handled conservatively', () => {
    assert.equal(taskAgeMs('not-a-date', NOW), null);
    assert.equal(taskAgeMs(new Date(NOW + 1_000).toISOString(), NOW), null);
    assert.equal(taskAgeMs(NOW - 1_000, NOW), 1_000);
    assert.equal(taskAgeMs(String(Math.floor((NOW - 2_000) / 1_000)), NOW), 2_000);
});
