/**
 * Persist the current health episode for each projected system component.
 * Keeping this state durable prevents status polling or process restarts from
 * manufacturing a new system-failure notification for the same outage.
 */
export async function up(knex) {
  await knex.schema.createTable('notification_system_health', (table) => {
    table.text('component').primary();
    table.text('status').notNullable();
    table.boolean('healthy').notNullable();
    table.text('transition_at').notNullable();
    table.text('updated_at').notNullable();

    table.check(
      "length(trim(component)) BETWEEN 1 AND 255 AND length(trim(status)) BETWEEN 1 AND 64",
      {},
      'notification_system_health_required_text_check'
    );
    table.check(
      'healthy IN (0, 1)',
      {},
      'notification_system_health_healthy_check'
    );
    table.check(
      "transition_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'",
      {},
      'notification_system_health_transition_at_check'
    );
    table.check(
      "updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'",
      {},
      'notification_system_health_updated_at_check'
    );
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('notification_system_health');
}
