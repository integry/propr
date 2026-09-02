/**
 * Record merged pull requests before dismissing their Inbox receipts. The
 * marker is authoritative for notification producers, so delayed projections
 * cannot recreate actionable cards after a merge webhook has been handled.
 */

const ISO_TIMESTAMP_CHECK = (column) => `
  typeof(${column}) = 'text'
  AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
`;

export async function up(knex) {
  await knex.schema.createTable('notification_pull_request_state', (table) => {
    table.text('repository').notNullable();
    table.integer('pr_number').notNullable();
    table.text('merged_at').nullable();

    table.primary(['repository', 'pr_number']);
    table.check(
      `length(CAST(repository AS BLOB)) BETWEEN 1 AND 255
        AND repository GLOB '*/*'
        AND pr_number BETWEEN 1 AND 9007199254740991`,
      {},
      'notification_pull_request_state_identity_check'
    );
    table.check(
      `merged_at IS NULL OR (${ISO_TIMESTAMP_CHECK('merged_at')})`,
      {},
      'notification_pull_request_state_timestamp_check'
    );
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('notification_pull_request_state');
}
