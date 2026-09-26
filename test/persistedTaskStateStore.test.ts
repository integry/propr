import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createObservations } from '../packages/core/src/db/migrations/20260925010000_create_task_reconciliation_observations.js';
import { createPersistedTaskStateStore } from '../src/persistedTaskStateStore.js';

async function createDatabase(): Promise<Knex> {
    const database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
    });
    await database.schema.createTable('tasks', table => {
        table.string('task_id').primary();
        table.string('job_id').nullable();
        table.string('repository').notNullable();
        table.integer('issue_number').nullable();
        table.string('task_type').nullable();
    });
    await database.schema.createTable('task_history', table => {
        table.increments('history_id').primary();
        table.string('task_id').notNullable();
        table.string('state').notNullable();
        table.timestamp('timestamp').notNullable();
        table.text('reason').nullable();
        table.json('metadata').nullable();
    });
    await createObservations(database);
    return database;
}

async function seedCandidate(database: Knex, taskId = 'task-1'): Promise<void> {
    await database('tasks').insert({
        task_id: taskId,
        job_id: 'bull-1',
        repository: 'integry/propr',
        issue_number: 42,
        task_type: 'issue',
    });
    await database('task_history').insert([
        {
            task_id: taskId,
            state: 'pending',
            timestamp: '2026-09-25T10:00:00.000Z',
            reason: 'created',
            metadata: '{}',
        },
        {
            task_id: taskId,
            state: 'processing',
            // Deliberately older: append order, not mixed timestamp formatting,
            // is authoritative for state transitions.
            timestamp: '2026-09-25T09:00:00.000Z',
            reason: 'started',
            metadata: '{}',
        },
    ]);
}

test('scans latest durable nonterminal states and records repeatable absence evidence', async () => {
    const database = await createDatabase();
    try {
        await seedCandidate(database);
        const publishTaskUpdate = mock.fn(async () => true);
        const store = createPersistedTaskStateStore(database, { publishTaskUpdate });

        const page = await store.scanNonTerminalTasks('0', 100);
        assert.equal(page.nextCursor, '0');
        assert.equal(page.tasks.length, 1);
        assert.equal(page.tasks[0].state, 'processing');
        assert.equal(page.tasks[0].jobId, 'bull-1');

        const first = await store.recordMissing(page.tasks[0], '2026-09-25T12:00:00.000Z');
        const second = await store.recordMissing(page.tasks[0], '2026-09-25T12:01:00.000Z');
        assert.deepEqual(first, {
            observations: 1,
            firstMissingAt: '2026-09-25T12:00:00.000Z',
        });
        assert.deepEqual(second, {
            observations: 2,
            firstMissingAt: '2026-09-25T12:00:00.000Z',
        });

        const finalized = await store.finalizeIfCurrent(page.tasks[0], {
            state: 'failed',
            reason: 'Task execution failed',
            metadata: { finalizedBy: 'orphan_reconciliation' },
        }, '2026-09-25T12:01:00.000Z');
        assert.deepEqual(finalized, { stateChanged: true, eventPublished: true });
        assert.equal((await database('task_history').where({ task_id: 'task-1' }).orderBy('history_id', 'desc').first()).state, 'failed');
        assert.equal((await database('task_reconciliation_observations').where({ task_id: 'task-1' })).length, 0);
        assert.equal(publishTaskUpdate.mock.calls.length, 1);
    } finally {
        await database.destroy();
    }
});

test('terminal finalization is compare-and-set against the scanned history row', async () => {
    const database = await createDatabase();
    try {
        await seedCandidate(database);
        const publishTaskUpdate = mock.fn(async () => true);
        const store = createPersistedTaskStateStore(database, { publishTaskUpdate });
        const candidate = (await store.scanNonTerminalTasks('0', 100)).tasks[0];

        await database('task_history').insert({
            task_id: candidate.taskId,
            state: 'post_processing',
            timestamp: '2026-09-25T12:00:30.000Z',
            reason: 'worker is still advancing',
            metadata: '{}',
        });
        const finalized = await store.finalizeIfCurrent(candidate, {
            state: 'failed',
            reason: 'Task execution failed',
            metadata: { finalizedBy: 'orphan_reconciliation' },
        }, '2026-09-25T12:01:00.000Z');

        assert.deepEqual(finalized, { stateChanged: false, eventPublished: false });
        const latest = await database('task_history')
            .where({ task_id: candidate.taskId })
            .orderBy('history_id', 'desc')
            .first();
        assert.equal(latest.state, 'post_processing');
        assert.equal(publishTaskUpdate.mock.calls.length, 0);
    } finally {
        await database.destroy();
    }
});

test('terminal finalization rejects a candidate whose job ID moved to a newer task', async () => {
    const database = await createDatabase();
    try {
        await seedCandidate(database);
        const publishTaskUpdate = mock.fn(async () => true);
        const store = createPersistedTaskStateStore(database, { publishTaskUpdate });
        const candidate = (await store.scanNonTerminalTasks('0', 100)).tasks[0];
        assert.equal(await store.ownsJobAssignment(candidate), true);

        // Mirrors task creation for a reused deterministic BullMQ job ID.
        await database('tasks').where({ job_id: 'bull-1' }).update({ job_id: null });
        await database('tasks').insert({
            task_id: 'task-2',
            job_id: 'bull-1',
            repository: 'integry/propr',
            issue_number: 42,
            task_type: 'issue',
        });

        assert.equal(await store.ownsJobAssignment(candidate), false);
        const finalized = await store.finalizeIfCurrent(candidate, {
            state: 'completed',
            reason: 'Task completed',
            metadata: { finalizedBy: 'bullmq_completed_reconciliation' },
        }, '2026-09-25T12:01:00.000Z');

        assert.deepEqual(finalized, { stateChanged: false, eventPublished: false });
        const latest = await database('task_history')
            .where({ task_id: candidate.taskId })
            .orderBy('history_id', 'desc')
            .first();
        assert.equal(latest.state, 'processing');
        assert.equal(publishTaskUpdate.mock.calls.length, 0);

        // The unlinked row is still finalizable once rescanned without a job ID.
        const rescanned = (await store.scanNonTerminalTasks('0', 100)).tasks
            .find(task => task.taskId === candidate.taskId);
        assert.equal(rescanned?.jobId, null);
        assert.equal(await store.ownsJobAssignment(rescanned!), true);
        const rescannedFinalized = await store.finalizeIfCurrent(rescanned!, {
            state: 'failed',
            reason: 'Task execution failed',
            metadata: { finalizedBy: 'orphan_reconciliation' },
        }, '2026-09-25T12:02:00.000Z');
        assert.deepEqual(rescannedFinalized, { stateChanged: true, eventPublished: true });
    } finally {
        await database.destroy();
    }
});

test('excludes terminal tasks and native goals from reconciliation scans', async () => {
    const database = await createDatabase();
    try {
        await seedCandidate(database, 'completed-task');
        await database('task_history').insert({
            task_id: 'completed-task',
            state: 'completed',
            timestamp: '2026-09-25T12:00:00.000Z',
        });
        await seedCandidate(database, 'native-goal');
        await database('tasks').where({ task_id: 'native-goal' }).update({ task_type: 'goal' });
        const store = createPersistedTaskStateStore(database, {
            publishTaskUpdate: async () => true,
        });

        assert.deepEqual((await store.scanNonTerminalTasks('0', 100)).tasks, []);
    } finally {
        await database.destroy();
    }
});
