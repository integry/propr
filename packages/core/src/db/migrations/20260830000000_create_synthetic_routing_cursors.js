/**
 * Persisted cursors used by synthetic-agent round-robin selection.
 *
 * Keeping the counter in SQLite (rather than in a worker process) makes a
 * synthetic pool rotate consistently when analysis, indexing, and task workers
 * select concurrently.
 */
export async function up(knex) {
  await knex.schema.createTable('synthetic_routing_cursors', table => {
    table.string('synthetic_model_key', 255).primary();
    table.bigInteger('cursor').notNullable().defaultTo(0);
    table.timestamp('updated_at').defaultTo(knex.fn.now()).notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('synthetic_routing_cursors');
}
