/**
 * Durable two-pass evidence for orphaned task reconciliation.
 *
 * Redis task state and retained BullMQ jobs are intentionally ephemeral. This
 * table lets the periodic reconciler require repeated absence observations
 * across process restarts before it terminalizes a durable SQLite task.
 */
export async function up(knex) {
  await knex.schema.createTable('task_reconciliation_observations', (table) => {
    table.string('task_id', 255).primary();
    table.integer('expected_history_id').notNullable();
    table.timestamp('first_missing_at').notNullable();
    table.timestamp('last_missing_at').notNullable();
    table.integer('observations').notNullable().defaultTo(1);

    table.foreign('task_id')
      .references('task_id')
      .inTable('tasks')
      .onDelete('CASCADE');
    table.index('last_missing_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_reconciliation_observations');
}
