import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { down, up } from '../packages/core/src/db/migrations/20261112180000_review_drafts_that_have_a_plan.js';

const PLAN = JSON.stringify([{ id: 'a', title: 'First', body: 'Do it' }]);

test('drafts that already hold plan items move to review; everything else is untouched', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        // No table yet: the migration is a no-op rather than an error.
        await up(database);

        await database.schema.createTable('task_drafts', table => {
            table.string('draft_id').primary();
            table.string('status').notNullable();
            table.text('plan_json');
        });
        await database('task_drafts').insert([
            { draft_id: 'with-plan', status: 'draft', plan_json: PLAN },
            { draft_id: 'prompt-only', status: 'draft', plan_json: null },
            { draft_id: 'empty-plan', status: 'draft', plan_json: '[]' },
            { draft_id: 'not-an-array', status: 'draft', plan_json: '{"items":[]}' },
            { draft_id: 'invalid-json', status: 'draft', plan_json: 'not json' },
            { draft_id: 'generating', status: 'generating', plan_json: PLAN },
            { draft_id: 'executed', status: 'executed', plan_json: PLAN },
        ]);

        await up(database);
        const statuses = async () => Object.fromEntries(
            (await database('task_drafts').select('draft_id', 'status')).map(row => [row.draft_id, row.status]),
        );
        const expected = {
            'with-plan': 'review',
            'prompt-only': 'draft',
            'empty-plan': 'draft',
            'not-an-array': 'draft',
            'invalid-json': 'draft',
            generating: 'generating',
            executed: 'executed',
        };
        assert.deepEqual(await statuses(), expected);

        // Running it again changes nothing, and down leaves the rows as they are.
        await up(database);
        await down();
        assert.deepEqual(await statuses(), expected);
    } finally {
        await database.destroy();
    }
});
