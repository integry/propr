/**
 * Coordinate entitlement refreshes across API replicas and canonicalize the
 * case-insensitive repository keys used only for authorization comparisons.
 */
async function insertInChunks(knex, table, rows) {
  const chunkSize = 250;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await knex(table).insert(rows.slice(offset, offset + chunkSize));
  }
}

export async function up(knex) {
  if (await knex.schema.hasTable('notification_repository_entitlements')) {
    const rows = await knex('notification_repository_entitlements')
      .select('user_id', 'repository', 'verified_at', 'expires_at')
      .orderBy('verified_at', 'asc');
    const normalized = new Map();
    for (const row of rows) {
      normalized.set(`${row.user_id}\0${row.repository.trim().toLowerCase()}`, {
        ...row,
        repository: row.repository.trim().toLowerCase(),
      });
    }
    await knex('notification_repository_entitlements').delete();
    await insertInChunks(
      knex,
      'notification_repository_entitlements',
      [...normalized.values()],
    );
  }

  if (await knex.schema.hasTable('notification_repository_subscriptions')) {
    const rows = await knex('notification_repository_subscriptions')
      .select('user_id', 'repository', 'hidden', 'updated_at')
      .orderBy('updated_at', 'asc');
    const normalized = new Map();
    for (const row of rows) {
      normalized.set(`${row.user_id}\0${row.repository.trim().toLowerCase()}`, {
        ...row,
        repository: row.repository.trim().toLowerCase(),
      });
    }
    await knex('notification_repository_subscriptions').delete();
    await insertInChunks(
      knex,
      'notification_repository_subscriptions',
      [...normalized.values()],
    );
  }

  if (!await knex.schema.hasTable('notification_repository_entitlement_refresh_leases')) {
    await knex.schema.createTable('notification_repository_entitlement_refresh_leases', (table) => {
      table.text('user_id').primary();
      table.text('lease_token').notNullable();
      table.text('expires_at').notNullable();
      table.check(
        "length(trim(user_id)) BETWEEN 1 AND 255 AND length(trim(lease_token)) BETWEEN 1 AND 255",
        {},
        'notification_repository_entitlement_refresh_leases_identity_check',
      );
      table.index(
        'expires_at',
        'notification_repository_entitlement_refresh_leases_expiry_idx',
      );
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('notification_repository_entitlement_refresh_leases');
}
