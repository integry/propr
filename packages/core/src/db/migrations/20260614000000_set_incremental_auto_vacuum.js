/**
 * Switch the SQLite database to auto_vacuum = INCREMENTAL.
 *
 * In the default NONE mode, deleting rows (e.g. the daemon's stale draft-context sweep)
 * frees pages for reuse but never returns them to the OS, so the file only ever grows.
 * INCREMENTAL mode lets us reclaim disk on demand via `PRAGMA incremental_vacuum`, which
 * the sweep runs after each batch.
 *
 * Changing the auto_vacuum mode only takes effect after a full VACUUM, and neither the
 * PRAGMA nor VACUUM may run inside a transaction — hence `config.transaction = false`.
 * The VACUUM is a one-time full rewrite (needs transient free disk ~= DB size); on a fresh
 * customer instance the DB is small, so this is cheap.
 */
export const config = { transaction: false };

export async function up(knex) {
  await knex.raw('PRAGMA auto_vacuum = INCREMENTAL;');
  await knex.raw('VACUUM;');
}

export async function down(knex) {
  await knex.raw('PRAGMA auto_vacuum = NONE;');
  await knex.raw('VACUUM;');
}
