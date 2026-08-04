const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';
const GENERATION_TABLE = 'notification_repository_entitlement_generations';

/** Make current pre-table lease generations restart-recoverable after upgrade. */
export async function up(knex) {
  if (!await knex.schema.hasTable(LEASE_TABLE)
      || !await knex.schema.hasTable(GENERATION_TABLE)
      || !await knex.schema.hasColumn(LEASE_TABLE, 'auth_generation')) return;
  const activatedAt = new Date().toISOString();
  const rows = await knex(LEASE_TABLE)
    .select('user_id', 'auth_generation')
    .whereNull('invalidated_at')
    .whereNotNull('auth_generation');
  if (rows.length === 0) return;
  const generations = rows.flatMap((row) => {
    const generation = typeof row.auth_generation === 'string'
      ? row.auth_generation.trim()
      : '';
    return generation ? [{
      user_id: row.user_id,
      auth_generation: generation,
      activated_at: activatedAt,
      invalidated_at: null,
    }] : [];
  });
  if (generations.length === 0) return;
  await knex(GENERATION_TABLE).insert(generations)
    .onConflict(['user_id', 'auth_generation']).ignore();
}

export async function down() {
  // Backfilled live generations are authorization state, not disposable schema.
}
