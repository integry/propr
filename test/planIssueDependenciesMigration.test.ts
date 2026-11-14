import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { down, up } from '../packages/core/src/db/migrations/20261112120000_add_plan_issue_dependencies.js';

test('plan issue dependency migration keeps existing rows, which read as no prerequisites, and reverts cleanly', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await database.migrate.latest({ directory: fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url)) });
    // Start from the schema before this migration, with published rows.
    await down(database);
    assert.equal(await database.schema.hasColumn('plan_issues', 'plan_item_id'), false);
    await database('task_drafts').insert({ draft_id: 'draft-1', user_id: 'user-1', repository: 'acme/repo', status: 'executed' });
    await database('plan_issues').insert([
      { draft_id: 'draft-1', repository: 'acme/repo', issue_number: 1, status: 'merged' },
      { draft_id: 'draft-1', repository: 'acme/repo', issue_number: 2, status: 'pending' },
    ]);

    await up(database);
    // Re-running is a no-op.
    await up(database);
    assert.deepEqual(await database('plan_issues').orderBy('issue_number').select('issue_number', 'status', 'plan_item_id', 'depends_on_issues'), [
      { issue_number: 1, status: 'merged', plan_item_id: null, depends_on_issues: null },
      { issue_number: 2, status: 'pending', plan_item_id: null, depends_on_issues: null },
    ]);
    await database('plan_issues').where({ issue_number: 2 }).update({ plan_item_id: 'api', depends_on_issues: '[1]' });
    assert.deepEqual(await database('plan_issues').where({ issue_number: 2 }).first('plan_item_id', 'depends_on_issues'),
      { plan_item_id: 'api', depends_on_issues: '[1]' });

    await down(database);
    assert.equal(await database.schema.hasColumn('plan_issues', 'plan_item_id'), false);
    assert.equal(await database.schema.hasColumn('plan_issues', 'depends_on_issues'), false);
    assert.equal((await database('plan_issues').select('id')).length, 2);
    await down(database);
    await up(database);
    assert.equal(await database.schema.hasColumn('plan_issues', 'depends_on_issues'), true);
  } finally {
    await database.destroy();
  }
});
