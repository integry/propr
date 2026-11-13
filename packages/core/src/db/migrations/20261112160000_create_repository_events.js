/**
 * Durable, append-only change-event journal for pull requests, epic queues and
 * plan issues (#3483).
 *
 * `seq` is AUTOINCREMENT so a cursor position is never reused, even after
 * retention deletes rows. Rows are written by explicit application appends
 * (`appendRepositoryEvent`), not triggers, so a later table rebuild has nothing
 * to recreate. `dedupe_key` makes an append idempotent per repository: SQLite
 * treats NULLs as distinct in a unique index, so events without a key never
 * collide.
 *
 * `repository_event_floors` records, per repository, the lowest `seq` that
 * retention may still have kept, so a reader can tell an expired cursor from an
 * empty result.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('repository_events')) {
    await knex.raw(`CREATE TABLE repository_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL,
      domain TEXT NOT NULL CHECK (domain IN ('pull_request', 'epic_queue', 'plan_issue')),
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
    await knex.raw('CREATE INDEX repository_events_repository_seq ON repository_events (repository, seq)');
    await knex.raw('CREATE INDEX repository_events_entity_seq ON repository_events (repository, domain, entity_id, seq)');
    await knex.raw('CREATE UNIQUE INDEX repository_events_dedupe ON repository_events (repository, dedupe_key)');
    // Retention deletes by age.
    await knex.raw('CREATE INDEX repository_events_occurred_at ON repository_events (occurred_at)');
  }
  if (!await knex.schema.hasTable('repository_event_floors')) {
    await knex.raw(`CREATE TABLE repository_event_floors (
      repository TEXT PRIMARY KEY,
      floor_seq INTEGER NOT NULL,
      pruned_at TEXT NOT NULL
    )`);
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('repository_event_floors');
  await knex.schema.dropTableIfExists('repository_events');
}
