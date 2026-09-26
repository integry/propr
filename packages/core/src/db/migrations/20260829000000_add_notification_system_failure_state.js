/**
 * Persist the latest system-health transition so notification projection is
 * consistent across API restarts and multiple API instances.
 */

const ISO_TIMESTAMP_CHECK = (column) => `
  typeof(${column}) = 'text'
  AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
`;

export async function up(knex) {
  await knex.schema.createTable('notification_system_failure_state', (table) => {
    table.text('component').notNullable().primary();
    table.text('failure_status').nullable();
    table.text('failure_started_at').nullable();
    table.text('last_snapshot_at').notNullable();

    table.check(
      `length(CAST(component AS BLOB)) BETWEEN 1 AND 255
        AND (failure_status IS NULL OR length(CAST(failure_status AS BLOB)) BETWEEN 1 AND 255)`,
      {},
      'notification_system_failure_state_text_check'
    );
    table.check(
      '(failure_status IS NULL) = (failure_started_at IS NULL)',
      {},
      'notification_system_failure_state_transition_check'
    );
    table.check(
      `${ISO_TIMESTAMP_CHECK('last_snapshot_at')}
        AND (failure_started_at IS NULL OR (
          ${ISO_TIMESTAMP_CHECK('failure_started_at')}
          AND failure_started_at <= last_snapshot_at
        ))`,
      {},
      'notification_system_failure_state_timestamp_check'
    );
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('notification_system_failure_state');
}
