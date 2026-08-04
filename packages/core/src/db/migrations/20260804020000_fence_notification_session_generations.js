const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';

/**
 * Associate entitlement activation/invalidation with an authenticated session
 * generation. A request from the generation that was logged out must never be
 * able to clear its own tombstone after the logout transaction commits.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable(LEASE_TABLE)
      || await knex.schema.hasColumn(LEASE_TABLE, 'auth_generation')) return;
  await knex.schema.alterTable(LEASE_TABLE, (table) => {
    table.text('auth_generation').nullable();
  });
}

export async function down(knex) {
  if (!await knex.schema.hasTable(LEASE_TABLE)
      || !await knex.schema.hasColumn(LEASE_TABLE, 'auth_generation')) return;
  await knex.schema.alterTable(LEASE_TABLE, (table) => {
    table.dropColumn('auth_generation');
  });
}
