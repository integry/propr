/**
 * Extend advertised Inbox actions for plan-ready notifications. Recreating the
 * trigger upgrades databases where the advertised-actions migration already ran.
 */

const COLUMN = 'advertised_actions_json';
const VALIDATION_TRIGGER = 'notification_events_advertised_actions_insert';

async function createValidationTrigger(knex, actions) {
  const allowed = actions.map(action => `'${action}'`).join(', ');
  await knex.raw(`DROP TRIGGER IF EXISTS ${VALIDATION_TRIGGER}`);
  await knex.raw(`
    CREATE TRIGGER ${VALIDATION_TRIGGER}
    BEFORE INSERT ON notification_events
    WHEN CASE
      WHEN NEW.${COLUMN} IS NULL THEN 0
      WHEN typeof(NEW.${COLUMN}) != 'text' OR NOT json_valid(NEW.${COLUMN}) THEN 1
      WHEN json_type(NEW.${COLUMN}) != 'array' THEN 1
      WHEN json_array_length(NEW.${COLUMN}) > ${actions.length} THEN 1
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.${COLUMN})
        WHERE type != 'text' OR value NOT IN (${allowed})
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
  await createValidationTrigger(knex, [
    'refine',
    'approve_execute',
    'stop',
    'follow_up',
    'open_pr',
    'dismiss',
  ]);
}

export async function down(knex) {
  await createValidationTrigger(knex, [
    'stop',
    'follow_up',
    'open_pr',
    'dismiss',
  ]);
}
