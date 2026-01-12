/**
 * Add branch support to indexing tables
 *
 * This migration adds a 'branch' column to support multi-branch indexing,
 * allowing the same repository to be indexed separately for different branches.
 */
export async function up(knex) {
  // 1. Repositories - add branch column and update primary key
  await knex.schema.alterTable('repositories', (table) => {
    table.string('branch').defaultTo('HEAD').notNullable();
  });

  // SQLite doesn't support dropping primary keys directly, so we need to recreate the table
  // For SQLite, we'll create a new table, copy data, drop old table, and rename
  const isSQLite = knex.client.config.client === 'sqlite3' || knex.client.config.client === 'better-sqlite3';

  if (isSQLite) {
    // SQLite approach: recreate tables with new schema

    // 1. Repositories table
    await knex.schema.createTable('repositories_new', (table) => {
      table.string('full_name').notNullable();
      table.string('branch').defaultTo('HEAD').notNullable();
      table.string('indexing_status').defaultTo('idle');
      table.timestamp('last_indexed_at').nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.primary(['full_name', 'branch']);
      table.index('indexing_status');
    });

    await knex.raw(`
      INSERT INTO repositories_new (full_name, branch, indexing_status, last_indexed_at, created_at, updated_at)
      SELECT full_name, branch, indexing_status, last_indexed_at, created_at, updated_at
      FROM repositories
    `);

    await knex.schema.dropTable('repositories');
    await knex.schema.renameTable('repositories_new', 'repositories');

    // 2. File Summaries table
    await knex.schema.createTable('file_summaries_new', (table) => {
      table.string('path').notNullable();
      table.string('branch').defaultTo('HEAD').notNullable();
      table.text('summary').notNullable();
      table.string('commit_hash').notNullable();
      table.string('model_used').nullable();
      table.timestamp('last_updated_at').defaultTo(knex.fn.now());
      table.primary(['path', 'branch']);
      table.index(['path', 'branch']);
    });

    await knex.raw(`
      INSERT INTO file_summaries_new (path, branch, summary, commit_hash, model_used, last_updated_at)
      SELECT path, 'HEAD', summary, commit_hash, model_used, last_updated_at
      FROM file_summaries
    `);

    await knex.schema.dropTable('file_summaries');
    await knex.schema.renameTable('file_summaries_new', 'file_summaries');

    // 3. Directory Summaries table
    await knex.schema.createTable('directory_summaries_new', (table) => {
      table.string('path').notNullable();
      table.string('branch').defaultTo('HEAD').notNullable();
      table.text('summary').notNullable();
      table.string('hash').notNullable();
      table.timestamp('last_updated_at').defaultTo(knex.fn.now());
      table.primary(['path', 'branch']);
    });

    await knex.raw(`
      INSERT INTO directory_summaries_new (path, branch, summary, hash, last_updated_at)
      SELECT path, 'HEAD', summary, hash, last_updated_at
      FROM directory_summaries
    `);

    await knex.schema.dropTable('directory_summaries');
    await knex.schema.renameTable('directory_summaries_new', 'directory_summaries');

  } else {
    // PostgreSQL/MySQL approach: alter tables directly

    // 1. Repositories
    await knex.schema.alterTable('repositories', (table) => {
      table.dropPrimary();
      table.primary(['full_name', 'branch']);
    });

    // 2. File Summaries
    await knex.schema.alterTable('file_summaries', (table) => {
      table.string('branch').defaultTo('HEAD').notNullable();
      table.dropPrimary();
      table.primary(['path', 'branch']);
      table.index(['path', 'branch']);
    });

    // 3. Directory Summaries
    await knex.schema.alterTable('directory_summaries', (table) => {
      table.string('branch').defaultTo('HEAD').notNullable();
      table.dropPrimary();
      table.primary(['path', 'branch']);
    });
  }
}

export async function down(knex) {
  const isSQLite = knex.client.config.client === 'sqlite3' || knex.client.config.client === 'better-sqlite3';

  if (isSQLite) {
    // SQLite approach: recreate tables with original schema

    // 1. Repositories table
    await knex.schema.createTable('repositories_old', (table) => {
      table.string('full_name').primary();
      table.string('indexing_status').defaultTo('idle');
      table.timestamp('last_indexed_at').nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index('indexing_status');
    });

    // Only keep HEAD branch records (or the first one for each repo)
    await knex.raw(`
      INSERT INTO repositories_old (full_name, indexing_status, last_indexed_at, created_at, updated_at)
      SELECT full_name, indexing_status, last_indexed_at, created_at, updated_at
      FROM repositories
      WHERE branch = 'HEAD'
      OR full_name NOT IN (SELECT full_name FROM repositories WHERE branch = 'HEAD')
      GROUP BY full_name
    `);

    await knex.schema.dropTable('repositories');
    await knex.schema.renameTable('repositories_old', 'repositories');

    // 2. File Summaries table
    await knex.schema.createTable('file_summaries_old', (table) => {
      table.string('path').primary();
      table.text('summary').notNullable();
      table.string('commit_hash').notNullable();
      table.string('model_used').nullable();
      table.timestamp('last_updated_at').defaultTo(knex.fn.now());
    });

    await knex.raw(`
      INSERT INTO file_summaries_old (path, summary, commit_hash, model_used, last_updated_at)
      SELECT path, summary, commit_hash, model_used, last_updated_at
      FROM file_summaries
      WHERE branch = 'HEAD'
      OR path NOT IN (SELECT path FROM file_summaries WHERE branch = 'HEAD')
      GROUP BY path
    `);

    await knex.schema.dropTable('file_summaries');
    await knex.schema.renameTable('file_summaries_old', 'file_summaries');

    // 3. Directory Summaries table
    await knex.schema.createTable('directory_summaries_old', (table) => {
      table.string('path').primary();
      table.text('summary').notNullable();
      table.string('hash').notNullable();
      table.timestamp('last_updated_at').defaultTo(knex.fn.now());
    });

    await knex.raw(`
      INSERT INTO directory_summaries_old (path, summary, hash, last_updated_at)
      SELECT path, summary, hash, last_updated_at
      FROM directory_summaries
      WHERE branch = 'HEAD'
      OR path NOT IN (SELECT path FROM directory_summaries WHERE branch = 'HEAD')
      GROUP BY path
    `);

    await knex.schema.dropTable('directory_summaries');
    await knex.schema.renameTable('directory_summaries_old', 'directory_summaries');

  } else {
    // PostgreSQL/MySQL approach

    // Revert Repositories
    await knex.schema.alterTable('repositories', (table) => {
      table.dropPrimary();
      table.dropColumn('branch');
      table.primary(['full_name']);
    });

    // Revert File Summaries
    await knex.schema.alterTable('file_summaries', (table) => {
      table.dropIndex(['path', 'branch']);
      table.dropPrimary();
      table.dropColumn('branch');
      table.primary(['path']);
    });

    // Revert Directory Summaries
    await knex.schema.alterTable('directory_summaries', (table) => {
      table.dropPrimary();
      table.dropColumn('branch');
      table.primary(['path']);
    });
  }
}
