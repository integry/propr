/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    // correlation_id should identify a group of related tasks (e.g. from one webhook),
    // so it should not be unique per row.
    table.dropUnique(['correlation_id']);
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.unique(['correlation_id']);
  });
}
