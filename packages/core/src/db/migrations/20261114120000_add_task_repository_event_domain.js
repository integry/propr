/**
 * Allow the `task` domain in the repository event journal (#3547).
 *
 * `repository_events.domain` carries a CHECK constraint, which SQLite cannot
 * alter in place, so the table is rebuilt with the wider constraint: rows are
 * copied with their `seq`, and the AUTOINCREMENT high-water mark is carried
 * over so a position retention already deleted is never handed out again.
 * The indexes of the original table and of the NOCASE index migration are
 * recreated. `repository_event_floors` and the journal identity are untouched,
 * so existing cursors stay valid.
 */
const DOMAINS_BEFORE = ['pull_request', 'epic_queue', 'plan_issue'];
const DOMAINS_AFTER = [...DOMAINS_BEFORE, 'task'];

async function rebuild(knex, domains) {
  const quoted = domains.map(domain => `'${domain}'`).join(', ');
  const [sequence] = await knex.raw("SELECT seq FROM sqlite_sequence WHERE name = 'repository_events'");
  await knex.raw('DROP TABLE IF EXISTS repository_events_rebuild');
  await knex.raw(`CREATE TABLE repository_events_rebuild (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    repository TEXT NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN (${quoted})),
    type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    pr_number INTEGER NULL,
    issue_number INTEGER NULL,
    plan_id TEXT NULL,
    head_sha TEXT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    dedupe_key TEXT NULL,
    occurred_at TEXT NOT NULL
  )`);
  const columns = 'seq, repository, domain, type, entity_id, pr_number, issue_number, plan_id, head_sha, payload, dedupe_key, occurred_at';
  await knex.raw(`INSERT INTO repository_events_rebuild (${columns}) SELECT ${columns} FROM repository_events WHERE domain IN (${quoted})`);
  await knex.raw('DROP TABLE repository_events');
  await knex.raw('ALTER TABLE repository_events_rebuild RENAME TO repository_events');
  await knex.raw('CREATE INDEX repository_events_repository_seq ON repository_events (repository, seq)');
  await knex.raw('CREATE INDEX repository_events_entity_seq ON repository_events (repository, domain, entity_id, seq)');
  await knex.raw('CREATE UNIQUE INDEX repository_events_dedupe ON repository_events (repository, dedupe_key)');
  await knex.raw('CREATE INDEX repository_events_occurred_at ON repository_events (occurred_at)');
  await knex.raw('CREATE INDEX repository_events_repository_nocase_seq ON repository_events (repository COLLATE NOCASE, seq)');
  const highWater = Number(sequence?.seq ?? 0);
  if (highWater > 0) {
    const [row] = await knex.raw("SELECT seq FROM sqlite_sequence WHERE name = 'repository_events'");
    if (row) await knex.raw("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'repository_events'", [highWater]);
    else await knex.raw("INSERT INTO sqlite_sequence (name, seq) VALUES ('repository_events', ?)", [highWater]);
  }
}

export async function up(knex) {
  if (!await knex.schema.hasTable('repository_events')) return;
  await rebuild(knex, DOMAINS_AFTER);
}

/** Rolling back drops the `task` events: the narrower constraint cannot hold them. */
export async function down(knex) {
  if (!await knex.schema.hasTable('repository_events')) return;
  await rebuild(knex, DOMAINS_BEFORE);
}
