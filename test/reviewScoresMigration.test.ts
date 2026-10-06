import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { up as createPullRequestState } from '../packages/core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { down, up } from '../packages/core/src/db/migrations/20261006000000_create_review_scores.js';

const SCORE_COLUMNS = [
    'id', 'repository_id', 'pr_number', 'task_id', 'implementation_task_id', 'implementer_agent', 'implementer_model',
    'reviewer_agent', 'reviewer_model', 'score', 'blocker_count', 'suggestion_count', 'cycle_number', 'goal', 'source',
    'head_sha', 'created_at',
];

test('review score migration creates the score table and PR outcome columns, and reverts cleanly', async () => {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await createPullRequestState(database);
        await database('notification_pull_request_state').insert({ repository: 'acme/repo', pr_number: 7, merged_at: null });

        await up(database);
        const columns = await database('review_scores').columnInfo();
        assert.deepEqual(SCORE_COLUMNS.filter(column => !columns[column]), []);
        const stateColumns = await database('notification_pull_request_state').columnInfo();
        assert.ok(stateColumns.outcome);
        assert.ok(stateColumns.closed_at);
        // Existing PR state rows survive with an unknown outcome.
        assert.deepEqual(await database('notification_pull_request_state').select('outcome', 'closed_at'), [{ outcome: null, closed_at: null }]);

        const row = {
            repository_id: 'acme/repo', pr_number: 7, task_id: 'review-1', score: 8, source: 'review',
            created_at: '2026-10-06T10:00:00.000Z',
        };
        await database('review_scores').insert(row);
        const [stored] = await database('review_scores').select('blocker_count', 'suggestion_count', 'cycle_number');
        assert.deepEqual(stored, { blocker_count: 0, suggestion_count: 0, cycle_number: null });
        await assert.rejects(database('review_scores').insert({ ...row, score: 11 }), /CHECK constraint/);
        await assert.rejects(database('review_scores').insert({ ...row, score: 0 }), /CHECK constraint/);
        await assert.rejects(database('review_scores').insert({ ...row, source: 'manual' }), /CHECK constraint/);
        await assert.rejects(database('notification_pull_request_state').update({ outcome: 'abandoned' }), /CHECK constraint/);

        await down(database);
        assert.equal(await database.schema.hasTable('review_scores'), false);
        const revertedColumns = await database('notification_pull_request_state').columnInfo();
        assert.equal(revertedColumns.outcome, undefined);
        assert.equal(revertedColumns.closed_at, undefined);
        assert.equal(await database('notification_pull_request_state').count('* as count').first().then(result => Number(result?.count)), 1);

        // The migration can be re-applied after a rollback.
        await up(database);
        assert.equal(await database.schema.hasTable('review_scores'), true);
    } finally {
        await database.destroy();
    }
});
