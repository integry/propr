/** Compatibility tombstone. This migration name is already recorded in the
 * knex_migrations ledger of published databases, so the file must keep
 * existing for migration-list validation. The schema it once created belonged
 * to the retired Connect-managed extension authority v2 plane and is dropped by
 * 20261015220000_remove_extension_authority_schema.js. It must never return. */
export async function up() {}
export async function down() {}
