import assert from 'node:assert/strict';
import { after, afterEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import knex from 'knex';
import { TaskStates } from '../packages/core/src/utils/workerStateManager.types.js';

const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
});

await database.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('job_id');
    table.text('correlation_id');
    table.text('repository');
    table.integer('issue_number');
    table.text('task_type');
    table.text('model_name');
    table.text('created_at');
    table.text('initial_job_data');
});
await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.text('task_id').notNullable();
    table.text('state').notNullable();
    table.text('timestamp').notNullable();
    table.text('reason');
    table.text('metadata');
});
await database.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id');
    table.text('name');
    table.text('initial_prompt');
    table.text('repository');
    table.text('status');
    table.text('created_at');
});

const missingRedis = {
    get: mock.fn(async () => null),
    eval: mock.fn(async () => 0),
    scan: mock.fn(async () => ['0', []]),
    on: mock.fn(),
    disconnect: mock.fn(),
};

await mock.module('ioredis', {
    namedExports: { Redis: function Redis() { return missingRedis; } },
});
await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { db: database },
});
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: {
        getEventPublisher: () => ({ publishTaskUpdate: mock.fn(async () => true) }),
    },
});

const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    withCorrelation: () => logger,
};
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: logger,
    namedExports: { generateCorrelationId: () => 'generated-correlation' },
});

const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');
const { taskStateExpectation } = await import('../packages/core/src/utils/workerStateTransition.js');

await mock.module('@propr/core', {
    namedExports: {
        TaskStates,
        taskStateExpectation,
        logger,
        inspectExactTaskContainerLivenessForTask: mock.fn(async () => 'not_found'),
        inspectLegacyDockerContainerLivenessForTask: mock.fn(async () => 'not_found'),
    },
});

const { reconcileStalePRCommentTasks } = await import('../src/taskStateReconciler.js');
const { createLiveActivityRoutes } = await import('../packages/api/routes/liveActivityRoutes.js');

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const STALE_TIMESTAMP = '2026-08-14T10:00:00.000Z';

async function seedTask(
    taskId: string,
    state = TaskStates.PROCESSING,
    jobId: string | null = `${taskId}-job`,
): Promise<void> {
    await database('tasks').insert({
        task_id: taskId,
        job_id: jobId,
        correlation_id: `correlation-${taskId}`,
        repository: 'integry/propr',
        issue_number: 1898,
        task_type: 'issue',
        model_name: 'test-model',
        created_at: STALE_TIMESTAMP,
        initial_job_data: JSON.stringify({
            type: 'issue',
            number: 1898,
            repoOwner: 'integry',
            repoName: 'propr',
            title: taskId,
        }),
    });
    await database('task_history').insert({
        task_id: taskId,
        state,
        timestamp: STALE_TIMESTAMP,
        reason: 'Seeded release smoke state',
        metadata: '{}',
    });
}

async function latestState(taskId: string): Promise<string> {
    const row = await database('task_history')
        .where({ task_id: taskId })
        .orderBy('history_id', 'desc')
        .first();
    return String(row?.state);
}

afterEach(async () => {
    await database('task_history').delete();
    await database('tasks').delete();
    await database('task_drafts').delete();
    missingRedis.get.mock.resetCalls();
    missingRedis.eval.mock.resetCalls();
});

after(async () => {
    await database.destroy();
});

test('scanRecoverableTasks recovers a missing-Redis DB row exactly once across contenders', async () => {
    await seedTask('db-recovery-contender', TaskStates.PROCESSING, null);
    const firstManager = new WorkerStateManager({ keyPrefix: 'release-smoke:first:' });
    const secondManager = new WorkerStateManager({ keyPrefix: 'release-smoke:second:' });

    assert.equal(await firstManager.getTaskState('db-recovery-contender'), null);
    const page = await firstManager.scanRecoverableTasks('database:', 10);
    assert.equal(page.tasks.length, 1);
    assert.equal(page.tasks[0].historyId !== undefined, true);
    const expected = taskStateExpectation(page.tasks[0]);

    const contenders = await Promise.all([
        firstManager.updateTaskStateIfCurrentDetailed(
            page.tasks[0].taskId,
            expected,
            TaskStates.FAILED,
            { reason: 'Recovered orphan' },
        ),
        secondManager.updateTaskStateIfCurrentDetailed(
            page.tasks[0].taskId,
            expected,
            TaskStates.FAILED,
            { reason: 'Competing orphan recovery' },
        ),
    ]);

    assert.equal(contenders.filter(Boolean).length, 1);
    assert.equal(await latestState('db-recovery-contender'), TaskStates.FAILED);
    assert.equal(
        await database('task_history').where({ task_id: 'db-recovery-contender' }).count({ count: '*' })
            .first().then(row => Number(row?.count)),
        2,
    );
    await firstManager.close();
    await secondManager.close();
});

test('late worker success wins after the recovery lease scan and cannot be regressed', async () => {
    await seedTask('late-worker-success', TaskStates.PROCESSING, null);
    const recoveryManager = new WorkerStateManager({ keyPrefix: 'release-smoke:recovery:' });
    const workerManager = new WorkerStateManager({ keyPrefix: 'release-smoke:worker:' });

    // The scanner owns its distributed lease before taking this DB snapshot.
    const [leasedCandidate] = (await recoveryManager.scanRecoverableTasks('database:', 10)).tasks;
    const expected = taskStateExpectation(leasedCandidate);
    const workerSuccess = await workerManager.updateTaskStateIfCurrentDetailed(
        leasedCandidate.taskId,
        expected,
        TaskStates.COMPLETED,
        { reason: 'Original worker completed successfully' },
    );
    const staleRecovery = await recoveryManager.updateTaskStateIfCurrentDetailed(
        leasedCandidate.taskId,
        expected,
        TaskStates.FAILED,
        { reason: 'Stale recovery attempt' },
    );

    assert.equal(workerSuccess?.state.state, TaskStates.COMPLETED);
    assert.equal(staleRecovery, null);
    assert.equal(await latestState(leasedCandidate.taskId), TaskStates.COMPLETED);
    const terminalRows = await database('task_history')
        .where({ task_id: leasedCandidate.taskId })
        .whereIn('state', [TaskStates.COMPLETED, TaskStates.CANCELLED, TaskStates.FAILED]);
    assert.deepEqual(terminalRows.map(row => row.state), [TaskStates.COMPLETED]);
    await recoveryManager.close();
    await workerManager.close();
});

test('release-equivalent SQLite/API smoke reconciles stale rows and preserves the exact header live set', async () => {
    const liveStates = ['active', 'waiting', 'delayed', 'prioritized'] as const;
    const liveTasks = liveStates.map(state => ({ taskId: `live-${state}`, state }));
    await Promise.all([
        seedTask('stale-orphan', TaskStates.PROCESSING, null),
        seedTask('stale-success'),
        seedTask('stale-skipped'),
        seedTask('historical-completed', TaskStates.COMPLETED),
        ...liveTasks.map(({ taskId }) => seedTask(taskId)),
    ]);
    await database('task_drafts').insert({
        draft_id: 'live-plan',
        user_id: 'user-1',
        name: 'Release plan',
        initial_prompt: 'Validate release activity',
        repository: 'integry/propr',
        status: 'generating',
        created_at: '2026-08-14T11:00:00.000Z',
    });
    const jobs = new Map<string, {
        id: string;
        data: { taskId: string };
        returnvalue?: unknown;
        getState(): Promise<string>;
    }>([
        ['stale-success-job', {
            id: 'stale-success-job',
            data: { taskId: 'stale-success' },
            returnvalue: { status: 'complete' },
            getState: async () => 'completed',
        }],
        ['stale-skipped-job', {
            id: 'stale-skipped-job',
            data: { taskId: 'stale-skipped' },
            returnvalue: { status: 'skipped' },
            getState: async () => 'completed',
        }],
        ...liveTasks.map(({ taskId, state }) => [
            `${taskId}-job`,
            {
                id: `${taskId}-job`,
                data: { taskId },
                getState: async () => state,
            },
        ] as const),
    ]);
    const queue = { getJob: async (jobId: string) => jobs.get(jobId) ?? null, getJobs: async () => [] };
    const stateManager = new WorkerStateManager({ keyPrefix: 'release-smoke:stack:' });
    const initialTaskCount = await database('tasks').count({ count: '*' }).first()
        .then(row => Number(row?.count));
    const initialHistoryCount = await database('task_history').count({ count: '*' }).first()
        .then(row => Number(row?.count));

    const reconciliation = await reconcileStalePRCommentTasks({
        queue,
        stateManager,
        cursor: 'database:',
        now: NOW,
        inspectContainer: async () => 'not_found',
    });

    assert.deepEqual(reconciliation.summary, {
        scanned: 7,
        stale: 7,
        live: 4,
        recovered: 2,
        skipped: 0,
        errors: 1,
    });
    assert.equal(await latestState('stale-orphan'), TaskStates.PROCESSING);
    assert.equal(await latestState('stale-success'), TaskStates.COMPLETED);
    assert.equal(await latestState('stale-skipped'), TaskStates.CANCELLED);

    const routes = createLiveActivityRoutes({
        db: database,
        taskQueue: queue as never,
        inspectContainer: async () => 'not_found',
    });
    let responseBody: { items: Array<{ id: string }>; total: number; remaining: number } | undefined;
    const request = { query: { limit: '50' }, user: { id: 'user-1' } } as unknown as Request;
    const response = {
        status() { return this; },
        json(body: typeof responseBody) { responseBody = body; return this; },
    } as unknown as Response;
    await routes.getLiveActivity(request, response);

    assert.ok(responseBody);
    assert.equal(responseBody.total, 5);
    assert.equal(responseBody.items.length, responseBody.total);
    assert.equal(responseBody.remaining, 0);
    assert.deepEqual(
        new Set(responseBody.items.map(item => item.id)),
        new Set(['live-plan', ...liveTasks.map(task => task.taskId)]),
    );
    assert.equal(await database('tasks').count({ count: '*' }).first().then(row => Number(row?.count)), initialTaskCount);
    assert.equal(
        await database('task_history').count({ count: '*' }).first().then(row => Number(row?.count)),
        initialHistoryCount + 2,
    );
    assert.equal(await latestState('historical-completed'), TaskStates.COMPLETED);
    await stateManager.close();
});
