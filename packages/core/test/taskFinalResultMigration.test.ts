import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import {
    down as removeTaskFinalResult,
    up as addTaskFinalResult
} from '../src/db/migrations/20260925000000_add_final_result_to_tasks.js';

test('adds a nullable task final result without changing existing rows', async () => {
    const database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true
    });

    try {
        await database.schema.createTable('tasks', table => {
            table.string('task_id').primary();
            table.json('initial_job_data');
        });
        await database('tasks').insert({
            task_id: 'existing-task',
            initial_job_data: JSON.stringify({ title: 'Existing task' })
        });

        await addTaskFinalResult(database);

        assert.equal(await database.schema.hasColumn('tasks', 'final_result'), true);
        assert.equal((await database('tasks').where({ task_id: 'existing-task' }).first()).final_result, null);

        const finalResult = { postProcessing: { pr: { number: 2517 } } };
        await database('tasks').where({ task_id: 'existing-task' }).update({
            final_result: JSON.stringify(finalResult)
        });
        const migrated = await database('tasks').where({ task_id: 'existing-task' }).first();
        assert.deepEqual(JSON.parse(migrated.final_result), finalResult);

        await removeTaskFinalResult(database);
        assert.equal(await database.schema.hasColumn('tasks', 'final_result'), false);
        assert.equal((await database('tasks').where({ task_id: 'existing-task' }).first()).task_id, 'existing-task');
    } finally {
        await database.destroy();
    }
});
