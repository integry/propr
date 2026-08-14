import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import { down, up } from '../packages/core/src/db/migrations/20260814000000_allow_reused_task_job_ids.js';

const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
});

await database.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('job_id').unique();
    table.text('created_at').notNullable();
});

after(async () => {
    await database.destroy();
});

test('rollback preserves task rows and deterministically detaches later reused job associations', async () => {
    const jobId = 'issue-integry-propr-1898-codex-gpt-5-main';
    await up(database);
    await database('tasks').insert([
        { task_id: 'execution-later', job_id: jobId, created_at: '2026-08-14T12:00:00.000Z' },
        { task_id: 'execution-earlier', job_id: jobId, created_at: '2026-08-14T11:00:00.000Z' },
        { task_id: 'unrelated', job_id: 'unrelated-job', created_at: '2026-08-14T10:00:00.000Z' },
    ]);

    assert.deepEqual(
        await database('tasks').where({ job_id: jobId }).orderBy('created_at').pluck('task_id'),
        ['execution-earlier', 'execution-later'],
    );

    await down(database);

    assert.deepEqual(
        await database('tasks').select('task_id', 'job_id').orderBy('task_id'),
        [
            { task_id: 'execution-earlier', job_id: jobId },
            { task_id: 'execution-later', job_id: null },
            { task_id: 'unrelated', job_id: 'unrelated-job' },
        ],
    );
    const indexes = await database.raw("PRAGMA index_list('tasks')") as Array<{ name: string; unique: number }>;
    const jobIdIndex = indexes.find(index => index.name === 'tasks_job_id_unique');
    assert.equal(jobIdIndex?.unique, 1);
    await assert.rejects(
        database('tasks').insert({
            task_id: 'duplicate-after-rollback',
            job_id: jobId,
            created_at: '2026-08-14T13:00:00.000Z',
        }),
        /UNIQUE constraint failed: tasks\.job_id/,
    );
});
