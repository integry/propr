/**
 * Persist a monotonic entitlement-refresh fence and replica-wide retry window.
 * Lease rows are retained after release so both values survive API restarts.
 */
export async function up(knex) {
  const table = 'notification_repository_entitlement_refresh_leases';
  if (!await knex.schema.hasTable(table)) return;

  if (!await knex.schema.hasColumn(table, 'fencing_token')) {
    await knex.schema.alterTable(table, (builder) => {
      builder.bigInteger('fencing_token').notNullable().defaultTo(0);
    });
  }
  if (!await knex.schema.hasColumn(table, 'retry_after')) {
    await knex.schema.alterTable(table, (builder) => {
      builder.text('retry_after').nullable();
      builder.index('retry_after', 'notification_repository_entitlement_refresh_retry_idx');
    });
  }
}

export async function down(knex) {
  const table = 'notification_repository_entitlement_refresh_leases';
  if (!await knex.schema.hasTable(table)) return;
  if (await knex.schema.hasColumn(table, 'retry_after')) {
    await knex.schema.alterTable(table, (builder) => {
      builder.dropIndex('retry_after', 'notification_repository_entitlement_refresh_retry_idx');
      builder.dropColumn('retry_after');
    });
  }
  if (await knex.schema.hasColumn(table, 'fencing_token')) {
    await knex.schema.alterTable(table, (builder) => {
      builder.dropColumn('fencing_token');
    });
  }
}
