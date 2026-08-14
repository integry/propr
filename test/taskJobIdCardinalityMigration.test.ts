import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import { up } from '../packages/core/src/db/migrations/20260814000000_allow_reused_task_job_ids.js';

const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
});

await database.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('job_id').unique();
});
await up(database);

after(async () => {
    await database.destroy();
});

test('two sequential task executions can persist the same reused BullMQ job ID', async () => {
    const jobId = 'issue-integry-propr-1898-codex-gpt-5-main';
    await database('tasks').insert({ task_id: 'execution-one', job_id: jobId });
    await database('tasks').insert({ task_id: 'execution-two', job_id: jobId });

    assert.deepEqual(
        await database('tasks').where({ job_id: jobId }).orderBy('task_id').pluck('task_id'),
        ['execution-one', 'execution-two'],
    );
    const indexes = await database.raw("PRAGMA index_list('tasks')") as Array<{ name: string; unique: number }>;
    const jobIdIndex = indexes.find(index => index.name === 'tasks_job_id_index');
    assert.equal(jobIdIndex?.unique, 0);
});
