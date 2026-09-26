import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { Knex } from 'knex';
import type { updateRepositoryStatus as updateStatus } from '../packages/core/src/services/relevance/summaryMinerQueries.ts';

const dataDir = path.join(os.tmpdir(), `propr-icon-metadata-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(dataDir, 'propr.sqlite');

let db: Knex;
let updateRepositoryStatus: typeof updateStatus;

before(async () => {
  const connection = await import('../packages/core/src/db/connection.ts');
  const queries = await import('../packages/core/src/services/relevance/summaryMinerQueries.ts');
  db = connection.db;
  updateRepositoryStatus = queries.updateRepositoryStatus;
  await db.migrate.latest();
  await db('repositories').delete();
});

after(async () => {
  await db.destroy();
});

test('indexing immediately persists a discovered icon and clears a removed one', async () => {
  await updateRepositoryStatus('integry/propr', 'completed', 'main', {
    hash: 'previous-indexed-hash',
    iconPath: 'public/old-logo.svg',
  });

  await updateRepositoryStatus('integry/propr', 'indexing', 'main', { iconPath: null });
  let row = await db('repositories').where({ full_name: 'integry/propr', branch: 'main' }).first();
  assert.equal(row.indexing_status, 'indexing');
  assert.equal(row.icon_path, null);
  assert.equal(row.last_indexed_hash, 'previous-indexed-hash');

  await updateRepositoryStatus('integry/propr', 'indexing', 'main', {
    iconPath: 'packages/web/public/favicon.svg',
  });
  await updateRepositoryStatus('integry/propr', 'failed', 'main');

  row = await db('repositories').where({ full_name: 'integry/propr', branch: 'main' }).first();
  assert.equal(row.indexing_status, 'failed');
  assert.equal(row.icon_path, 'packages/web/public/favicon.svg');
});
