/**
 * Migration script: PostgreSQL to SQLite
 *
 * This script migrates all data from PostgreSQL to SQLite.
 * Run with: npx tsx scripts/migrate-pg-to-sqlite.ts
 */
import 'dotenv/config';
import knex, { Knex } from 'knex';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tables to migrate in dependency order (referenced tables first)
const TABLES_TO_MIGRATE = [
  'tasks',
  'task_history',
  'llm_executions',
  'llm_execution_details',
  'task_drafts'
];

async function migrate() {
  console.log('='.repeat(60));
  console.log('PostgreSQL to SQLite Migration');
  console.log('='.repeat(60));

  // 1. Configure PostgreSQL connection (source)
  const pgConfig: Knex.Config = {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      user: process.env.DB_USER ?? 'gitfix_user',
      password: process.env.DB_PASSWORD ?? 'gitfix_password',
      database: process.env.DB_NAME ?? 'gitfix_history'
    }
  };

  // 2. Configure SQLite connection (target)
  const sqliteDbPath = process.env.DB_FILENAME ?? path.join(__dirname, '../data/gitfix.sqlite');
  const sqliteDir = path.dirname(sqliteDbPath);

  // Ensure data directory exists
  if (!fs.existsSync(sqliteDir)) {
    fs.mkdirSync(sqliteDir, { recursive: true });
    console.log(`Created directory: ${sqliteDir}`);
  }

  const sqliteConfig: Knex.Config = {
    client: 'better-sqlite3',
    connection: {
      filename: sqliteDbPath
    },
    useNullAsDefault: true,
    migrations: {
      directory: path.join(__dirname, '../packages/core/src/db/migrations'),
      tableName: 'knex_migrations'
    },
    pool: {
      afterCreate: (conn: { pragma: (arg: string) => void }, done: (err: Error | null) => void) => {
        conn.pragma('foreign_keys = ON');
        done(null);
      }
    }
  };

  const pgDb = knex(pgConfig);
  const sqliteDb = knex(sqliteConfig);

  try {
    // Test PostgreSQL connection
    console.log('\nConnecting to PostgreSQL...');
    await pgDb.raw('SELECT 1');
    console.log('✓ Connected to PostgreSQL');

    // Run migrations on SQLite to create schema
    console.log('\nRunning migrations on SQLite...');
    await sqliteDb.migrate.latest();
    console.log('✓ SQLite schema created');

    // Migrate data
    console.log('\n' + '-'.repeat(60));
    console.log('Migrating data...');
    console.log('-'.repeat(60));

    let totalRows = 0;

    for (const table of TABLES_TO_MIGRATE) {
      console.log(`\nMigrating table: ${table}`);

      // Check if table exists in PostgreSQL
      const pgExists = await pgDb.schema.hasTable(table);
      if (!pgExists) {
        console.log(`  ⚠ Table '${table}' does not exist in PostgreSQL, skipping`);
        continue;
      }

      // Count rows in source
      const [countResult] = await pgDb(table).count('* as count');
      const rowCount = parseInt(String(countResult.count), 10);

      if (rowCount === 0) {
        console.log(`  ⚠ No rows to migrate`);
        continue;
      }

      console.log(`  Found ${rowCount} rows`);

      // Fetch all rows from PostgreSQL
      const rows = await pgDb(table).select('*');

      // Clear existing data in SQLite (in case of re-run)
      await sqliteDb(table).del();

      // Batch insert into SQLite
      const batchSize = 100;
      let migrated = 0;

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        // Convert JSONB fields to strings for SQLite
        const processedBatch = batch.map(row => {
          const processed: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) {
            if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
              processed[key] = JSON.stringify(value);
            } else {
              processed[key] = value;
            }
          }
          return processed;
        });

        await sqliteDb(table).insert(processedBatch);
        migrated += batch.length;

        // Progress indicator
        const progress = Math.round((migrated / rows.length) * 100);
        process.stdout.write(`\r  Migrated: ${migrated}/${rows.length} (${progress}%)`);
      }

      console.log(`\n  ✓ Migrated ${migrated} rows`);
      totalRows += migrated;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Migration completed successfully!`);
    console.log(`Total rows migrated: ${totalRows}`);
    console.log(`SQLite database: ${sqliteDbPath}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n✗ Migration failed:', (error as Error).message);
    console.error((error as Error).stack);
    process.exit(1);
  } finally {
    await pgDb.destroy();
    await sqliteDb.destroy();
  }
}

migrate();
