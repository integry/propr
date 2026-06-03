import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import type { Knex } from 'knex';
import type { clearRemovedRepositoryIndexData as cleanupFn } from '../packages/core/src/config/configManagerIndexing.ts';

const dataDir = path.join(os.tmpdir(), `propr-index-cleanup-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(dataDir, 'propr.sqlite');

const now = new Date().toISOString();
let db: Knex;
let closeConnection: () => Promise<void>;
let clearRemovedRepositoryIndexData: typeof cleanupFn;

async function seedRepositoryIndex(repository: string, branch: string): Promise<void> {
  await db('repositories').insert({
    full_name: repository,
    branch,
    indexing_status: 'completed',
    last_indexed_at: now,
    created_at: now,
    updated_at: now,
    last_indexed_hash: `${branch}-hash`,
    last_indexed_commit_message: `${branch} commit`,
    icon_path: null
  });

  await db('file_summaries').insert({
    path: `${repository}/src/index.ts`,
    branch,
    summary: `${repository} ${branch} file`,
    commit_hash: `${branch}-file-hash`,
    model_used: 'test',
    last_updated_at: now
  });

  await db('directory_summaries').insert({
    path: `${repository}/src`,
    branch,
    summary: `${repository} ${branch} directory`,
    hash: `${branch}-directory-hash`,
    last_updated_at: now
  });
}

async function countRows(table: string, repository: string, branch?: string): Promise<number> {
  const query = db(table);
  if (table === 'repositories') {
    query.where({ full_name: repository });
  } else {
    query.where('path', 'like', `${repository}/%`);
  }
  if (branch) query.andWhere({ branch });
  const row = await query.count<{ count: number | string }[]>({ count: '*' }).first();
  return Number(row?.count ?? 0);
}

describe('repository index cleanup', () => {
  before(async () => {
    const connection = await import('../packages/core/src/db/connection.ts');
    const indexing = await import('../packages/core/src/config/configManagerIndexing.ts');
    db = connection.db;
    closeConnection = connection.closeConnection;
    clearRemovedRepositoryIndexData = indexing.clearRemovedRepositoryIndexData;
    await db.migrate.latest();
  });

  after(async () => {
    await closeConnection();
  });

  beforeEach(async () => {
    await db('file_summaries').delete();
    await db('directory_summaries').delete();
    await db('repositories').delete();
  });

  test('removing one configured branch deletes only that branch index data', async () => {
    await seedRepositoryIndex('integry/propr', 'main');
    await seedRepositoryIndex('integry/propr', 'develop');
    await seedRepositoryIndex('integry/other', 'develop');

    const cleanup = await clearRemovedRepositoryIndexData(
      [
        { name: 'integry/propr', baseBranch: 'main' },
        { name: 'integry/propr', baseBranch: 'develop' }
      ],
      [{ name: 'integry/propr', baseBranch: 'main' }]
    );

    assert.deepStrictEqual(cleanup, {
      repositories: 1,
      file_summaries: 1,
      directory_summaries: 1
    });
    assert.strictEqual(await countRows('repositories', 'integry/propr', 'main'), 1);
    assert.strictEqual(await countRows('repositories', 'integry/propr', 'develop'), 0);
    assert.strictEqual(await countRows('file_summaries', 'integry/propr', 'main'), 1);
    assert.strictEqual(await countRows('file_summaries', 'integry/propr', 'develop'), 0);
    assert.strictEqual(await countRows('directory_summaries', 'integry/propr', 'main'), 1);
    assert.strictEqual(await countRows('directory_summaries', 'integry/propr', 'develop'), 0);
    assert.strictEqual(await countRows('repositories', 'integry/other', 'develop'), 1);
    assert.strictEqual(await countRows('file_summaries', 'integry/other', 'develop'), 1);
    assert.strictEqual(await countRows('directory_summaries', 'integry/other', 'develop'), 1);
  });

  test('removing the final configured repository entry deletes all branch index data', async () => {
    await seedRepositoryIndex('integry/propr', 'main');
    await seedRepositoryIndex('integry/propr', 'develop');
    await seedRepositoryIndex('integry/other', 'main');

    const cleanup = await clearRemovedRepositoryIndexData(
      [{ name: 'integry/propr', baseBranch: 'main' }],
      []
    );

    assert.deepStrictEqual(cleanup, {
      repositories: 2,
      file_summaries: 2,
      directory_summaries: 2
    });
    assert.strictEqual(await countRows('repositories', 'integry/propr'), 0);
    assert.strictEqual(await countRows('file_summaries', 'integry/propr'), 0);
    assert.strictEqual(await countRows('directory_summaries', 'integry/propr'), 0);
    assert.strictEqual(await countRows('repositories', 'integry/other', 'main'), 1);
    assert.strictEqual(await countRows('file_summaries', 'integry/other', 'main'), 1);
    assert.strictEqual(await countRows('directory_summaries', 'integry/other', 'main'), 1);
  });

  test('saving with no removed repository entries does not clear index data', async () => {
    await seedRepositoryIndex('integry/propr', 'main');

    const cleanup = await clearRemovedRepositoryIndexData(
      [{ name: 'integry/propr', baseBranch: 'main' }],
      [{ name: 'integry/propr', baseBranch: 'main' }]
    );

    assert.deepStrictEqual(cleanup, {
      repositories: 0,
      file_summaries: 0,
      directory_summaries: 0
    });
    assert.strictEqual(await countRows('repositories', 'integry/propr', 'main'), 1);
    assert.strictEqual(await countRows('file_summaries', 'integry/propr', 'main'), 1);
    assert.strictEqual(await countRows('directory_summaries', 'integry/propr', 'main'), 1);
  });
});
