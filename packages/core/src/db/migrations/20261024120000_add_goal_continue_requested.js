/**
 * Set when an operator continues a terminal goal. The next attempt re-arms the
 * provider's native goal even when the provider itself recorded it complete or
 * failed, then clears the flag. It stays set until an attempt has actually run,
 * so a lost or crashed first attempt still re-arms on recovery.
 *
 * ADD/DROP COLUMN are native SQLite statements; they do not rebuild `goals`,
 * so the goal_events triggers on it survive.
 */
export async function up(knex) {
  if (await knex.schema.hasColumn('goals', 'continue_requested')) return;
  await knex.raw('ALTER TABLE goals ADD COLUMN continue_requested BOOLEAN NOT NULL DEFAULT 0');
}

export async function down(knex) {
  if (!await knex.schema.hasColumn('goals', 'continue_requested')) return;
  await knex.raw('ALTER TABLE goals DROP COLUMN continue_requested');
}
