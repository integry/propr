import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { isDuplicateExecutionRow } from '../packages/core/src/utils/llmMetricsExecutionClaim.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
let db: Knex;

before(async () => {
    db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.migrate.latest({ directory: migrations });
});

after(async () => { await db.destroy(); });

const execution = (uuid: string | null) => ({ task_id: null, start_time: new Date().toISOString(), model_name: 'm', success: true, execution_uuid: uuid });

test('the database keeps one execution row per execution id, and the error is recognised as that duplicate', async () => {
    await db('llm_executions').insert(execution('execution-3437')).returning('execution_id');
    const error = await db('llm_executions').insert(execution('execution-3437')).returning('execution_id').then(() => null, (caught: unknown) => caught);
    assert.ok(error, 'the second row is rejected');
    assert.equal(isDuplicateExecutionRow(error), true);
    assert.equal(Number((await db('llm_executions').where({ execution_uuid: 'execution-3437' }).count({ count: '*' }).first())?.count), 1);
});

test('rows without an execution id are not constrained, and other failures are not duplicates', async () => {
    await db('llm_executions').insert(execution(null));
    await db('llm_executions').insert(execution(null));
    assert.equal(Number((await db('llm_executions').whereNull('execution_uuid').count({ count: '*' }).first())?.count), 2);
    const missingModel = await db('llm_executions').insert({ ...execution('other'), model_name: null }).then(() => null, (caught: unknown) => caught);
    assert.ok(missingModel);
    assert.equal(isDuplicateExecutionRow(missingModel), false);
});

test('the migration rolls back', async () => {
    await db.migrate.down({ directory: migrations });
    assert.equal(await db.schema.hasColumn('llm_executions', 'execution_uuid'), false);
    await db.migrate.latest({ directory: migrations });
    assert.equal(await db.schema.hasColumn('llm_executions', 'execution_uuid'), true);
});
