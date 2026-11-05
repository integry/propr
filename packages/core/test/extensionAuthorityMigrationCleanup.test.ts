import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { applyDatabaseMigrations } from '../src/db/migrationGate.js';
import { RETIRED_EXTENSION_AUTHORITY_NAME, RETIRED_EXTENSION_AUTHORITY_TABLES, RETIRED_EXTENSION_AUTHORITY_TRIGGERS } from '../src/db/migrations/20261015220000_remove_extension_authority_schema.js';

const directory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const EPOCH = '20261015070000_extension_authority_epoch.js';
const V2 = '20261015130000_extension_authority_v2.js';
const CLEANUP = '20261015220000_remove_extension_authority_schema.js';

// Verbatim schema of the two published migrations before they became
// tombstones. An upgrading database carries exactly these objects.
const historical: Record<string, (db: Knex) => Promise<void>> = {
  [EPOCH]: async db => {
    await db.schema.createTable('native_authority_epoch', t => { t.integer('id').primary(); t.bigInteger('epoch').notNullable(); });
    await db('native_authority_epoch').insert({ id: 1, epoch: 1 });
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      await db.raw(`CREATE TRIGGER native_authority_${event.toLowerCase()} AFTER ${event} ON instance_members BEGIN
        UPDATE native_authority_epoch SET epoch = epoch + 1 WHERE id = 1; END`);
    }
    await db.schema.createTable('extension_authority_challenges', t => { t.text('challenge').primary(); });
    await db.schema.createTable('extension_authority_operations', t => {
      t.text('operation_id').primary(); t.text('commitment').notNullable(); t.text('epoch').notNullable();
      t.boolean('dispatched').notNullable().defaultTo(false); t.boolean('completed').notNullable().defaultTo(false);
    });
  },
  [V2]: async db => {
    await db.schema.createTable('extension_authority_v2_clock', t => { t.integer('id').primary(); t.bigInteger('checked_ms').notNullable(); });
    await db('extension_authority_v2_clock').insert({ id: 1, checked_ms: 0 });
    await db.schema.createTable('extension_authority_v2_operations', t => {
      t.text('operation_id').primary(); t.text('work_digest').notNullable(); t.text('nonce').notNullable().unique();
      t.text('trust_digest').notNullable(); t.text('core_key_digest').notNullable();
    });
    await db.schema.createTable('extension_authority_v2_intents', t => {
      t.text('challenge').primary(); t.text('operation_id').notNullable(); t.text('phase').notNullable(); t.text('envelope_digest').notNullable();
    });
    await db.raw("CREATE UNIQUE INDEX extension_authority_v2_phase ON extension_authority_v2_intents(operation_id, phase) WHERE phase != 'status'");
    await db.schema.createTable('extension_authority_v2_receipts', t => {
      t.text('challenge').primary().references('challenge').inTable('extension_authority_v2_intents'); t.text('response').notNullable(); t.text('response_digest').notNullable();
    });
    for (const table of ['operations', 'intents', 'receipts']) for (const event of ['UPDATE', 'DELETE']) {
      await db.raw(`CREATE TRIGGER extension_authority_v2_${table}_${event.toLowerCase()} BEFORE ${event} ON extension_authority_v2_${table} BEGIN SELECT RAISE(ABORT, 'Immutable extension authority record'); END`);
    }
  },
};

interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null }

function open(filename: string, source?: Knex.MigrationSource<string>): Knex {
  // Knex ignores a custom migrationSource whenever a directory is configured.
  return knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true,
    // Durability is irrelevant for a throwaway fixture; this keeps four full migration runs fast.
    pool: { afterCreate(connection: { pragma(statement: string): unknown }, done: (error: Error | null, connection: unknown) => void) {
      connection.pragma('journal_mode = MEMORY'); connection.pragma('synchronous = OFF'); done(null, connection);
    } },
    migrations: { tableName: 'knex_migrations', ...(source ? { migrationSource: source } : { directory }) } });
}

/** The migration directory as it existed when the retired migrations were live. */
async function historicalSource(): Promise<Knex.MigrationSource<string>> {
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.js') && name <= V2).sort();
  return {
    getMigrations: async () => names,
    getMigrationName: name => name,
    getMigration: async name => name in historical ? { up: historical[name], down: async () => {} } : await import(path.join(directory, name)),
  };
}

async function schema(db: Knex): Promise<SchemaRow[]> {
  const rows = await db.raw<SchemaRow[]>("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'knex_migrations%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  return rows;
}

async function ledger(db: Knex): Promise<string[]> {
  return (await db('knex_migrations').orderBy('id').pluck('name')) as string[];
}

const obsolete = (rows: SchemaRow[]) => rows.filter(row => RETIRED_EXTENSION_AUTHORITY_NAME.test(row.name) || RETIRED_EXTENSION_AUTHORITY_NAME.test(row.tbl_name)).map(row => `${row.type}:${row.name}`);

test('cleanup migration retires the published extension authority schema without touching the ledger history', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-authority-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upgraded = path.join(root, 'upgraded.sqlite');
  const blank = path.join(root, 'blank.sqlite');

  // 1. An old-style database: knex itself recorded both retired names and the
  //    retired schema is physically present, exactly as published installs have.
  const old = open(upgraded, await historicalSource());
  t.after(() => old.destroy());
  await applyDatabaseMigrations(old);
  const recorded = await ledger(old);
  assert.deepEqual(recorded.filter(name => /extension_authority/.test(name)), [EPOCH, V2]);
  assert.equal(recorded.at(-1), V2);
  assert.equal(recorded.includes(CLEANUP), false);
  const before = await schema(old);
  assert.deepEqual(obsolete(before).filter(name => name.startsWith('table:')).sort(),
    [...RETIRED_EXTENSION_AUTHORITY_TABLES].map(name => `table:${name}`).sort());
  for (const trigger of RETIRED_EXTENSION_AUTHORITY_TRIGGERS) assert.ok(obsolete(before).includes(`trigger:${trigger}`), trigger);
  assert.ok(obsolete(before).includes('index:extension_authority_v2_phase'));
  await old.destroy();

  // 2. Normal startup on the current migration directory: the tombstones keep
  //    migration-list validation green and the cleanup runs once.
  const current = open(upgraded);
  t.after(() => current.destroy());
  await applyDatabaseMigrations(current);
  assert.deepEqual((await current.migrate.list())[1], []);
  const history = await ledger(current);
  assert.deepEqual(history.filter(name => /extension_authority/.test(name)), [EPOCH, V2, CLEANUP]);
  assert.deepEqual(history.slice(0, recorded.length), recorded, 'existing ledger rows are untouched');
  assert.deepEqual(obsolete(await schema(current)), []);
  // Unrelated tables that the retired triggers were attached to are preserved.
  assert.ok(await current.schema.hasTable('instance_members'));
  // Re-running is a no-op and the cleanup stays idempotent if replayed directly.
  await applyDatabaseMigrations(current);
  await (await import(path.join(directory, CLEANUP))).up(current);
  assert.deepEqual(obsolete(await schema(current)), []);

  // 3. A blank database migrated to latest never acquires the obsolete schema,
  //    and converges on the same schema as the upgraded database.
  const fresh = open(blank);
  t.after(() => fresh.destroy());
  await applyDatabaseMigrations(fresh);
  assert.deepEqual((await fresh.migrate.list())[1], []);
  assert.deepEqual((await ledger(fresh)).filter(name => /extension_authority/.test(name)), [EPOCH, V2, CLEANUP]);
  assert.deepEqual(obsolete(await schema(fresh)), []);
  assert.deepEqual(await schema(fresh), await schema(current), 'upgraded and blank databases end on an equivalent schema');
});

test('tombstone migrations are inert and the cleanup migration never recreates retired schema', async () => {
  for (const name of [EPOCH, V2]) {
    const text = await fs.readFile(path.join(directory, name), 'utf8');
    assert.doesNotMatch(text, /createTable|CREATE |insert\(/, name);
    const migration = await import(path.join(directory, name));
    const sentinel = { schema: { createTable() { throw new Error('tombstone touched schema'); } }, raw() { throw new Error('tombstone ran SQL'); } };
    await migration.up(sentinel); await migration.down(sentinel);
  }
  const cleanup = await fs.readFile(path.join(directory, CLEANUP), 'utf8');
  assert.doesNotMatch(cleanup, /createTable|CREATE /);
  assert.match(cleanup, /DROP TRIGGER IF EXISTS/);
  assert.match(cleanup, /DROP INDEX IF EXISTS/);
  assert.match(cleanup, /dropTableIfExists/);
});
