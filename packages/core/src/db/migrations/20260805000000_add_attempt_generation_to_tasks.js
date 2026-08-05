/**
 * Stores a one-way attempt identifier so durable task metadata updates can be
 * conditionally fenced without persisting the renewable Redis lease token.
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.string('attempt_generation', 64).nullable().index();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.dropColumn('attempt_generation');
  });
}
