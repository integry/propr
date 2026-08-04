const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';

/**
 * Keep a durable logout tombstone in the refresh-coordination row. Deleting the
 * row allowed a registration that was already in flight on another API replica
 * to recreate it after logout and subsequently restore repository access.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable(LEASE_TABLE)) return;
  if (!await knex.schema.hasColumn(LEASE_TABLE, 'invalidated_at')) {
    await knex.schema.alterTable(LEASE_TABLE, (table) => {
      table.text('invalidated_at').nullable();
      table.index('invalidated_at', 'notification_repository_entitlement_invalidation_idx');
    });
  }
}

export async function down(knex) {
  if (!await knex.schema.hasTable(LEASE_TABLE)
      || !await knex.schema.hasColumn(LEASE_TABLE, 'invalidated_at')) return;
  await knex.schema.alterTable(LEASE_TABLE, (table) => {
    table.dropIndex('invalidated_at', 'notification_repository_entitlement_invalidation_idx');
    table.dropColumn('invalidated_at');
  });
}
