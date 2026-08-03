/** Durable, monotonic change stream for metadata added after a task transition. */
export async function up(knex) {
  if (await knex.schema.hasTable('task_notification_enrichments')) return;
  await knex.schema.createTable('task_notification_enrichments', (table) => {
    table.increments('change_id').primary();
    table.string('task_id', 255).notNullable();
    table.string('state', 50).notNullable();
    table.integer('transition_history_id').nullable();
    table.text('transition_at').notNullable();
    table.text('changed_at').notNullable();
    table.text('metadata').notNullable();
    table.foreign('task_id').references('task_id').inTable('tasks').onDelete('CASCADE');
    table.foreign('transition_history_id')
      .references('history_id').inTable('task_history').onDelete('CASCADE');
    table.index(['change_id', 'task_id'], 'task_notification_enrichments_cursor_idx');
    table.index(['task_id', 'changed_at'], 'task_notification_enrichments_task_idx');
    table.check(
      "length(trim(task_id)) BETWEEN 1 AND 255 AND length(trim(state)) BETWEEN 1 AND 50",
      {},
      'task_notification_enrichments_identity_check'
    );
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_notification_enrichments');
}
