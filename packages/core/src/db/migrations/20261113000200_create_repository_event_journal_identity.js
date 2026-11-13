import { randomBytes } from 'node:crypto';

/**
 * Durable identity of this database's repository event journal (#3484).
 *
 * Journal `seq` values are assigned independently by every ProPR instance, so
 * two instances that journal the same repository have overlapping sequence
 * ranges. Every cursor carries this identifier, and a reader rejects a cursor
 * issued by another journal as `CURSOR_INVALID` instead of resuming at a
 * foreign position and silently skipping its own unread events.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('repository_event_journal_identity')) {
    await knex.raw(`CREATE TABLE repository_event_journal_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      journal_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }
  await knex.raw('INSERT OR IGNORE INTO repository_event_journal_identity (id, journal_id, created_at) VALUES (1, ?, ?)',
    [randomBytes(16).toString('base64url'), new Date().toISOString()]);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('repository_event_journal_identity');
}
