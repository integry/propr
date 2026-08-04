import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import knex from 'knex';
import { up as addIndexingTransitionIdentity }
  from '../src/db/migrations/20260802030000_add_indexing_transition_identity.js';
import { closeConnection } from '../src/db/connection.js';
import { getActiveRepositoryIndexingRuns }
  from '../src/services/relevance/summaryMinerQueries.js';

after(async () => closeConnection());

test('indexing identity migration canonicalizes repositories and backfills active run owners', async () => {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  try {
    await database.schema.createTable('repositories', (table) => {
      table.text('full_name').notNullable();
      table.text('branch').notNullable();
      table.text('indexing_status').notNullable();
      table.text('last_indexed_at');
      table.text('last_indexed_hash');
      table.text('last_indexed_commit_message');
      table.text('icon_path');
      table.text('created_at').notNullable();
      table.text('updated_at').notNullable();
      table.primary(['full_name', 'branch']);
    });
    await database('repositories').insert([
      {
        full_name: 'Acme/API', branch: 'main', indexing_status: 'completed',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T01:00:00.000Z',
        last_indexed_at: '2026-08-01T00:30:00.000Z',
        last_indexed_hash: 'preserved-hash',
        last_indexed_commit_message: 'Preserve this metadata',
        icon_path: '/icons/acme-api.png',
      },
      {
        full_name: 'acme/api', branch: 'main', indexing_status: 'indexing',
        created_at: '2026-08-02T00:00:00.000Z',
        updated_at: '2026-08-02T01:00:00.000Z',
      },
    ]);

    await addIndexingTransitionIdentity(database);

    const repository = await database('repositories').first(
      'full_name', 'branch', 'indexing_status', 'indexing_transition_at', 'indexing_run_id',
      'last_indexed_at', 'last_indexed_hash', 'last_indexed_commit_message', 'icon_path',
      'created_at'
    );
    const expectedRunId = `legacy-${createHash('sha256')
      .update(['acme/api', 'main', '2026-08-02T01:00:00.000Z'].join('\0'))
      .digest('hex')}`;
    assert.deepEqual(repository, {
      full_name: 'acme/api',
      branch: 'main',
      indexing_status: 'indexing',
      indexing_transition_at: '2026-08-02T01:00:00.000Z',
      indexing_run_id: expectedRunId,
      last_indexed_at: '2026-08-01T00:30:00.000Z',
      last_indexed_hash: 'preserved-hash',
      last_indexed_commit_message: 'Preserve this metadata',
      icon_path: '/icons/acme-api.png',
      created_at: '2026-08-01T00:00:00.000Z',
    });
    assert.deepEqual(await getActiveRepositoryIndexingRuns('ACME/API', 'main', database), [{
      fullName: 'acme/api',
      branch: 'main',
      transitionAt: '2026-08-02T01:00:00.000Z',
      runId: expectedRunId,
    }]);
    await assert.rejects(database('repositories').insert({
      full_name: 'ACME/API',
      branch: 'main',
      indexing_status: 'idle',
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    }), /UNIQUE constraint failed/);
  } finally {
    await database.destroy();
  }
});
