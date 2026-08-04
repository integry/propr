/** Durable cursors keep reconciliation incremental across process restarts. */
export async function up(knex) {
  await knex.schema.createTable('notification_projection_checkpoints', (table) => {
    table.text('source').primary();
    table.text('cursor').notNullable();
    table.text('updated_at').notNullable();
    table.check(
      "length(trim(source)) BETWEEN 1 AND 100",
      {},
      'notification_projection_checkpoints_source_check'
    );
  });

  if (await knex.schema.hasTable('repository_indexing_transitions')) {
    await knex.schema.alterTable('repository_indexing_transitions', (table) => {
      table.index(
        ['observed_at', 'transition_id'],
        'repository_indexing_transitions_retention_idx'
      );
    });
  }
}

export async function down(knex) {
  if (await knex.schema.hasTable('repository_indexing_transitions')) {
    await knex.schema.alterTable('repository_indexing_transitions', (table) => {
      table.dropIndex(
        ['observed_at', 'transition_id'],
        'repository_indexing_transitions_retention_idx'
      );
    });
  }
  await knex.schema.dropTableIfExists('notification_projection_checkpoints');
}
