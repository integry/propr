/**
 * Change task_drafts.name column from string(255) to text
 * This allows storing full plan names without backend truncation
 * Truncation should happen on the frontend via CSS only
 */
export async function up(knex) {
  // SQLite doesn't support ALTER COLUMN directly, so we need to recreate the table
  // For SQLite, we'll use a workaround: create a new column, copy data, drop old, rename new

  // Check if we're using SQLite
  const client = knex.client.config.client;

  if (client === 'sqlite3' || client === 'better-sqlite3') {
    // SQLite approach: rename table, create new table with correct schema, copy data
    await knex.raw('ALTER TABLE task_drafts RENAME COLUMN name TO name_old');
    await knex.schema.alterTable('task_drafts', (table) => {
      table.text('name').defaultTo('Untitled Plan');
    });
    await knex.raw('UPDATE task_drafts SET name = name_old');
    await knex.schema.alterTable('task_drafts', (table) => {
      table.dropColumn('name_old');
    });
  } else {
    // PostgreSQL/MySQL approach: direct ALTER COLUMN
    await knex.schema.alterTable('task_drafts', (table) => {
      table.text('name').alter();
    });
  }
}

export async function down(knex) {
  const client = knex.client.config.client;

  if (client === 'sqlite3' || client === 'better-sqlite3') {
    await knex.raw('ALTER TABLE task_drafts RENAME COLUMN name TO name_old');
    await knex.schema.alterTable('task_drafts', (table) => {
      table.string('name', 255).defaultTo('Untitled Plan');
    });
    // Truncate to 255 chars when reverting
    await knex.raw("UPDATE task_drafts SET name = SUBSTR(name_old, 1, 255)");
    await knex.schema.alterTable('task_drafts', (table) => {
      table.dropColumn('name_old');
    });
  } else {
    await knex.schema.alterTable('task_drafts', (table) => {
      table.string('name', 255).alter();
    });
  }
}
