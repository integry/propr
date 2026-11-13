/**
 * Repository identity is case-insensitive, and journal rows keep whatever
 * spelling their producer supplied (a webhook's `repository.full_name` can
 * differ in case from the configured name). Readers match
 * `repository = ? COLLATE NOCASE`, which the BINARY
 * `repository_events_repository_seq` index cannot serve; this index can.
 */
export async function up(knex) {
  await knex.raw('CREATE INDEX IF NOT EXISTS repository_events_repository_nocase_seq ON repository_events (repository COLLATE NOCASE, seq)');
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS repository_events_repository_nocase_seq');
}
