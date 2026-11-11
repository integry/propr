import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { up as createPullRequestState } from '../packages/core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../packages/core/src/db/migrations/20261006000000_create_review_scores.js';
import { down, up } from '../packages/core/src/db/migrations/20261111000000_add_reasoning_level_columns.js';

test('reasoning level migration adds nullable columns, keeps existing rows null, and reverts cleanly', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await database.schema.createTable('tasks', table => { table.string('task_id').primary(); });
        await database.schema.createTable('llm_executions', table => {
            table.increments('execution_id');
            table.string('task_id').references('task_id').inTable('tasks').onDelete('CASCADE');
            table.string('model_name').notNullable();
            table.boolean('success').notNullable();
            table.boolean('cache_usage_reported').nullable();
        });
        await createPullRequestState(database);
        await createReviewScores(database);
        await database('tasks').insert({ task_id: 'task-1' });
        await database('llm_executions').insert({ task_id: 'task-1', model_name: 'claude-opus-5-5', success: true, cache_usage_reported: true });
        await database('review_scores').insert({
            repository_id: 'acme/repo', pr_number: 7, task_id: 'review-1', implementer_model: 'claude-opus-5-5', score: 8, source: 'review',
            created_at: '2026-11-11T10:00:00.000Z',
        });

        await up(database);
        // Re-running is a no-op.
        await up(database);
        assert.deepEqual(await database('llm_executions').select('model_name', 'reasoning_level', 'cache_usage_reported'),
            [{ model_name: 'claude-opus-5-5', reasoning_level: null, cache_usage_reported: 1 }]);
        assert.deepEqual(await database('review_scores').select('implementer_model', 'implementer_reasoning_level'),
            [{ implementer_model: 'claude-opus-5-5', implementer_reasoning_level: null }]);
        await database('llm_executions').insert({ task_id: 'task-1', model_name: 'gpt-5.6', success: false, reasoning_level: 'xhigh' });
        await database('review_scores').update({ implementer_reasoning_level: 'auto' });

        await down(database);
        assert.equal(await database.schema.hasColumn('llm_executions', 'reasoning_level'), false);
        assert.equal(await database.schema.hasColumn('review_scores', 'implementer_reasoning_level'), false);
        assert.equal((await database('llm_executions').select('execution_id')).length, 2);
        assert.equal((await database('review_scores').select('id')).length, 1);
        // Rolling back twice is a no-op, and the migration can be re-applied.
        await down(database);
        await up(database);
        assert.equal(await database.schema.hasColumn('llm_executions', 'reasoning_level'), true);
        assert.equal(await database.schema.hasColumn('review_scores', 'implementer_reasoning_level'), true);
    } finally {
        await database.destroy();
    }
});

test('reasoning level migration tolerates a database without review scores', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await database.schema.createTable('llm_executions', table => { table.increments('execution_id'); });
        await up(database);
        assert.equal(await database.schema.hasColumn('llm_executions', 'reasoning_level'), true);
        await down(database);
        assert.equal(await database.schema.hasColumn('llm_executions', 'reasoning_level'), false);
    } finally {
        await database.destroy();
    }
});
