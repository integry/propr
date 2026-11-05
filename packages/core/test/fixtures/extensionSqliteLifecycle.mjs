import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import Database from 'better-sqlite3';
import knex from 'knex';

async function exercise(fail) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-sqlite-lifecycle-'));
  const filename = path.join(root, 'lifecycle.sqlite');
  let native;
  let database;
  const connections = [];
  let pool;
  try {
    native = new Database(filename);
    native.pragma('journal_mode = WAL');
    native.exec('CREATE TABLE records (value INTEGER)');
    database = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true,
      pool: { afterCreate(connection, done) { connections.push(connection); done(null, connection); } },
    });
    pool = database.client.pool;
    for (let batch = 0; batch < 40; batch++) {
      // Drive statement collection from asynchronous I/O as well as allocation.
      // Explicit global.gc() alone does not reproduce ObjectWrap's missing context.
      await fs.readFile(import.meta.filename);
      for (let i = 0; i < 1000; i++) assert.equal(native.prepare('SELECT 1 AS value').get().value, 1);
      assert.deepEqual(await database('records').select('*'), []);
    }
    if (fail) throw new Error('synthetic setup failure');
  } finally {
    try { if (database) await database.destroy(); }
    finally {
      try { if (native?.open) native.close(); }
      finally { await fs.rm(root, { recursive: true, force: true }); }
      if (native) assert.equal(native.open, false);
      assert.ok(connections.every(connection => !connection.open));
      if (pool) { assert.equal(pool.numUsed(), 0); assert.equal(pool.numFree(), 0); }
    }
  }
  assert.ok(connections.length > 0);
}

// Check both outcomes' handles, including an exception during fixture setup.
await exercise(false);
await assert.rejects(exercise(true), /synthetic setup failure/);
// Let unreachable, already-closed native wrappers be collected after I/O resumes.
for (let i = 0; i < 80; i++) {
  await fs.readFile(import.meta.filename);
  Array.from({ length: 20_000 }, (_, index) => ({ index, text: String(index) }));
}
if (isMainThread) {
  await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url));
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`SQLite worker exited ${code}`)));
  });
  console.log('SQLite process and worker cleanup complete');
}
