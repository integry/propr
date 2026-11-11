import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import knex from 'knex';
import { closeConnection, type RepositoryValidationResult } from '@propr/core';
import { recordRepositoryValidationEvent, repositoryValidationEvent } from '../src/jobs/repositoryValidationEvent.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('tasks', table => { table.string('task_id'); });
await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state'); table.string('timestamp'); table.text('reason'); table.text('metadata');
});
after(async () => { await database.destroy(); await closeConnection(); });
beforeEach(async () => {
    await database('task_history').delete();
    await database('tasks').delete();
    await database('tasks').insert({ task_id: 'task-1' });
});

const result: RepositoryValidationResult = {
    overall: 'failed',
    commands: [
        { index: 0, command: 'npm test', status: 'passed', verified: true },
        { index: 1, command: 'npm run lint', status: 'failed', exitCode: 1, verified: true },
        { index: 2, command: 'npm run build', status: 'not_run', reason: 'execution_ended', verified: true },
    ],
};
const silent = { warn() {} };
const deps = { database: database as never, currentState: async () => 'processing' };

test('the event summarises the outcome and keeps the structured result under a stable key', () => {
    const event = repositoryValidationEvent(result);
    assert.equal(event.reason, 'Repository validation failed: 1 passed, 1 failed, 1 not run');
    assert.deepEqual(event.metadata, { event: 'repository.validation', repositoryValidation: result });
});

test('records one non-lifecycle timeline row that repeats the current state', async () => {
    await recordRepositoryValidationEvent('task-1', result, silent, deps);
    const rows = await database('task_history').select();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'processing');
    assert.equal(rows[0].reason, 'Repository validation failed: 1 passed, 1 failed, 1 not run');
    assert.deepEqual(JSON.parse(rows[0].metadata), { event: 'repository.validation', repositoryValidation: result });
});

test('a run without validation, or without a task, records nothing', async () => {
    await recordRepositoryValidationEvent('task-1', undefined, silent, deps);
    await recordRepositoryValidationEvent('task-1', { overall: 'passed', commands: [] }, silent, deps);
    await recordRepositoryValidationEvent('missing', result, silent, deps);
    assert.equal((await database('task_history').select()).length, 0);
});

test('a failed timeline write is logged and never fails the run', async () => {
    const warnings: unknown[] = [];
    await recordRepositoryValidationEvent('task-1', result, { warn: (...args: unknown[]) => { warnings.push(args); } }, {
        ...deps, currentState: async () => { throw new Error('state store unavailable'); },
    });
    assert.equal(warnings.length, 1);
    assert.equal((await database('task_history').select()).length, 0);
});
