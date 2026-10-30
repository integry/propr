/**
 * Connect browser sign-in grants can be renewed through the relay (#3387).
 * `renewal` records how the credential is renewed ('relay', or null for
 * today's refresh-token or non-renewable grants). The lease columns give every
 * process sharing this database one in-flight renewal per grant, and the
 * retry columns back off after transient relay failures.
 *
 * ADD/DROP COLUMN are native SQLite statements and do not rebuild the table.
 */
const COLUMNS = [
  ['renewal', 'renewal TEXT NULL'],
  ['renewal_lease_owner', 'renewal_lease_owner TEXT NULL'],
  ['renewal_lease_until_ms', 'renewal_lease_until_ms BIGINT NULL'],
  ['renewal_retry_after_ms', 'renewal_retry_after_ms BIGINT NULL'],
  ['renewal_failures', 'renewal_failures INTEGER NOT NULL DEFAULT 0'],
];

export async function up(knex) {
  if (!await knex.schema.hasTable('github_user_grants')) return;
  for (const [name, definition] of COLUMNS) {
    if (await knex.schema.hasColumn('github_user_grants', name)) continue;
    await knex.raw(`ALTER TABLE github_user_grants ADD COLUMN ${definition}`);
  }
}

export async function down(knex) {
  if (!await knex.schema.hasTable('github_user_grants')) return;
  for (const [name] of [...COLUMNS].reverse()) {
    if (!await knex.schema.hasColumn('github_user_grants', name)) continue;
    await knex.raw(`ALTER TABLE github_user_grants DROP COLUMN ${name}`);
  }
}
