/** Removes every schema object introduced solely by the retired Connect-managed
 * extension authority / result-delivery plane. Databases created before the
 * retirement still carry these objects; blank databases never get them because
 * the originating migrations are now inert tombstones. Every step is idempotent
 * so both histories converge on the same schema. Nothing here is recreated on
 * rollback: the feature is gone and the data was bounded protocol metadata. */
export const RETIRED_EXTENSION_AUTHORITY_TRIGGERS = Object.freeze([
  ...['insert', 'update', 'delete'].map(event => `native_authority_${event}`),
  ...['operations', 'intents', 'receipts'].flatMap(table => ['update', 'delete'].map(event => `extension_authority_v2_${table}_${event}`)),
]);
export const RETIRED_EXTENSION_AUTHORITY_INDEXES = Object.freeze(['extension_authority_v2_phase']);
export const RETIRED_EXTENSION_AUTHORITY_TABLES = Object.freeze([
  'extension_authority_v2_receipts', 'extension_authority_v2_intents', 'extension_authority_v2_operations', 'extension_authority_v2_clock',
  'extension_authority_operations', 'extension_authority_challenges', 'native_authority_epoch',
]);
export const RETIRED_EXTENSION_AUTHORITY_NAME = /^(native_authority_|extension_authority_)/;

export async function up(knex) {
  for (const trigger of RETIRED_EXTENSION_AUTHORITY_TRIGGERS) await knex.raw(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const index of RETIRED_EXTENSION_AUTHORITY_INDEXES) await knex.raw(`DROP INDEX IF EXISTS ${index}`);
  for (const table of RETIRED_EXTENSION_AUTHORITY_TABLES) await knex.schema.dropTableIfExists(table);
}
export async function down() {}
