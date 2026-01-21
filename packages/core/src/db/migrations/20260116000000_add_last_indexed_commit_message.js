/**
 * Add last_indexed_commit_message column to repositories table
 *
 * This migration adds a 'last_indexed_commit_message' column to store the git commit message
 * at which the repository was last indexed. This enables showing users which commit
 * the current index is based on.
 */
export async function up(knex) {
  await knex.schema.alterTable('repositories', (table) => {
    table.string('last_indexed_commit_message').nullable();
  });
}

export async function down(knex) {
  // SQLite doesn't support dropping columns directly, recreate the table
  await knex.schema.createTable('repositories_new', (table) => {
    table.string('full_name').notNullable();
    table.string('branch').defaultTo('HEAD').notNullable();
    table.string('indexing_status').defaultTo('idle');
    table.timestamp('last_indexed_at').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.string('last_indexed_hash').nullable();
    table.primary(['full_name', 'branch']);
    table.index('indexing_status');
  });

  await knex.raw(`
    INSERT INTO repositories_new (full_name, branch, indexing_status, last_indexed_at, created_at, updated_at, last_indexed_hash)
    SELECT full_name, branch, indexing_status, last_indexed_at, created_at, updated_at, last_indexed_hash
    FROM repositories
  `);

  await knex.schema.dropTable('repositories');
  await knex.schema.renameTable('repositories_new', 'repositories');
}
