/**
 * Store advertised Inbox actions independently from producer-owned metadata.
 *
 * Existing rows intentionally retain NULL in this column. That value is the
 * database-level discriminator for legacy events, which never advertised the
 * newer foreground controls.
 */

const COLUMN = 'advertised_actions_json';
const VALIDATION_TRIGGER = 'notification_events_advertised_actions_insert';

async function createValidationTrigger(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS ${VALIDATION_TRIGGER}`);
  await knex.raw(`
    CREATE TRIGGER ${VALIDATION_TRIGGER}
    BEFORE INSERT ON notification_events
    WHEN CASE
      WHEN NEW.${COLUMN} IS NULL THEN 0
      WHEN typeof(NEW.${COLUMN}) != 'text' OR NOT json_valid(NEW.${COLUMN}) THEN 1
      WHEN json_type(NEW.${COLUMN}) != 'array' THEN 1
      WHEN json_array_length(NEW.${COLUMN}) > 6 THEN 1
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.${COLUMN})
        WHERE type != 'text'
          OR value NOT IN ('refine', 'approve_execute', 'stop', 'follow_up', 'open_pr', 'dismiss')
      ) THEN 1
      WHEN (
        SELECT count(*) FROM json_each(NEW.${COLUMN})
      ) != (
        SELECT count(DISTINCT value) FROM json_each(NEW.${COLUMN})
      ) THEN 1
      ELSE 0
    END
    BEGIN
      SELECT RAISE(ABORT, 'invalid notification advertised actions');
    END
  `);
}

export async function up(knex) {
  if (!(await knex.schema.hasColumn('notification_events', COLUMN))) {
    await knex.schema.alterTable('notification_events', (table) => {
      table.text(COLUMN).nullable();
    });
  }
  await createValidationTrigger(knex);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS ${VALIDATION_TRIGGER}`);
  if (await knex.schema.hasColumn('notification_events', COLUMN)) {
    // Use SQLite's native operation. Knex's compatibility rebuild temporarily
    // removes notification_events and invalidates triggers on recipient tables.
    await knex.raw(`ALTER TABLE notification_events DROP COLUMN ${COLUMN}`);
  }
}
