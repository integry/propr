const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';
const GENERATION_TABLE = 'notification_repository_entitlement_generations';

/** Retain per-session tombstones so a logged-out generation can never reactivate. */
export async function up(knex) {
  if (!await knex.schema.hasTable(LEASE_TABLE)
      || !await knex.schema.hasColumn(LEASE_TABLE, 'auth_generation')
      || await knex.schema.hasTable(GENERATION_TABLE)) return;
  await knex.schema.createTable(GENERATION_TABLE, (table) => {
    table.text('user_id').notNullable();
    table.text('auth_generation').notNullable();
    table.text('activated_at').notNullable();
    table.text('invalidated_at').nullable();
    table.primary(['user_id', 'auth_generation']);
    table.index(
      ['user_id', 'invalidated_at'],
      'notification_repository_entitlement_generations_invalidation_idx'
    );
    table.index(
      'invalidated_at',
      'notification_repository_entitlement_generations_gc_idx'
    );
    table.check(
      'length(trim(user_id)) BETWEEN 1 AND 255 '
        + 'AND length(trim(auth_generation)) BETWEEN 1 AND 255',
      {},
      'notification_repository_entitlement_generations_identity_check'
    );
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(GENERATION_TABLE);
}
