import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import knex from 'knex';

const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
});
// Mirrors the production tasks.job_id uniqueness constraint.
await database.schema.createTable('tasks', table => {
    table.string('task_id', 255).primary();
    table.string('job_id', 255).unique();
    table.string('correlation_id').nullable();
    table.string('repository').notNullable();
    table.integer('issue_number').notNullable();
    table.string('task_type').nullable();
    table.string('model_name').nullable();
    table.timestamp('created_at').nullable();
    table.text('initial_job_data').nullable();
});
await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id').notNullable();
    table.string('state').notNullable();
    table.timestamp('timestamp').notNullable();
    table.text('reason').nullable();
    table.json('metadata').nullable();
});

const redisValues = new Map<string, string>();
await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return {
                setex: async (key: string, _ttl: number, value: string) => {
                    redisValues.set(key, value);
                    return 'OK';
                },
                get: async (key: string) => redisValues.get(key) ?? null,
                on: () => {},
                quit: async () => {},
                disconnect: () => {},
            };
        },
    },
});
await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { db: database },
});
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});
const persistenceErrors = mock.fn();
const correlatedLogger = { info: mock.fn(), debug: mock.fn(), warn: mock.fn(), error: persistenceErrors };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        debug: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        withCorrelation: () => correlatedLogger,
    },
    namedExports: { generateCorrelationId: () => 'generated-correlation-id' },
});

const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');
const stateManager = new WorkerStateManager({ keyPrefix: 'test:job-id:', stateExpiry: 3600 });

after(async () => {
    await stateManager.close();
    await database.destroy();
});

async function historyStates(taskId: string): Promise<string[]> {
    const rows = await database('task_history').where({ task_id: taskId }).orderBy('history_id');
    return rows.map(row => String(row.state));
}

test('a retried job with a stable task ID keeps one durable task row', async () => {
    const issueRef = { number: 0, repoOwner: 'integry', repoName: 'propr', type: 'task-import' };
    await stateManager.createTaskState('task-import-import-tasks-1', issueRef, 'corr-1', 'import-tasks-1');
    await stateManager.createTaskState('task-import-import-tasks-1', issueRef, 'corr-1', 'import-tasks-1');

    const rows = await database('tasks').where({ job_id: 'import-tasks-1' });
    assert.deepEqual(rows.map(row => row.task_id), ['task-import-import-tasks-1']);
    assert.deepEqual(await historyStates('task-import-import-tasks-1'), ['pending', 'pending']);
    assert.equal(persistenceErrors.mock.callCount(), 0);
});

test('a reused BullMQ job ID is transferred to the new task instead of dropping its durable row', async () => {
    const jobId = 'issue-integry-propr-7-claude-opus-5-5-main';
    const issueRef = { number: 7, repoOwner: 'integry', repoName: 'propr' };
    await stateManager.createTaskState('issue-7-first-run', issueRef, 'corr-first', jobId);
    await stateManager.createTaskState('issue-7-second-run', issueRef, 'corr-second', jobId);

    const rows = await database('tasks')
        .whereIn('task_id', ['issue-7-first-run', 'issue-7-second-run'])
        .orderBy('task_id')
        .select('task_id', 'job_id');
    assert.deepEqual(rows, [
        { task_id: 'issue-7-first-run', job_id: null },
        { task_id: 'issue-7-second-run', job_id: jobId },
    ]);
    assert.deepEqual(await historyStates('issue-7-second-run'), ['pending']);
    assert.equal(persistenceErrors.mock.callCount(), 0);
});
