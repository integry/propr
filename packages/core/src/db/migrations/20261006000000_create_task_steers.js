/**
 * Operator steering messages for ordinary (non-goal) task runs.
 *
 * A steer is claimed by setting `delivered_at` before it is written to the
 * agent, so it is delivered at most once even across worker restarts.
 * `delivery` records how it reached the agent: `live` (written into the
 * running session) or `replacement_prompt` (carried into the prompt of a
 * replacement run because the previous run ended before delivering it).
 * `acknowledged_at` is set once a live write was fully flushed to the agent.
 * `run_key` identifies the run that accepted the steer, for the per-run limit.
 */
export async function up(knex) {
  await knex.schema.createTable('task_steers', table => {
    table.increments('sequence').primary();
    table.string('steer_id', 36).notNullable().unique();
    table.string('task_id', 255).notNullable();
    table.string('run_key', 255);
    table.string('author', 255).notNullable();
    table.string('author_source', 20).notNullable();
    table.text('message').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('delivered_at');
    table.string('delivery', 20);
    table.timestamp('acknowledged_at');

    table.foreign('task_id')
      .references('task_id')
      .inTable('tasks')
      .onDelete('CASCADE');
    table.index(['task_id', 'sequence']);
    table.index(['task_id', 'delivered_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_steers');
}
