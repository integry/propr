/**
 * Add last_indexed_hash column to repositories table
 *
 * This migration adds a 'last_indexed_hash' column to track the git commit hash
 * at which the repository was last indexed. This enables detecting new commits
 * and triggering re-indexing without waiting for the full 24-hour interval.
 */
export async function up(knex) {
  await knex.schema.alterTable('repositories', (table) => {
    table.string('last_indexed_hash').nullable();
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
}
