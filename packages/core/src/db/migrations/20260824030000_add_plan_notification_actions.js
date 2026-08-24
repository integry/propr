/**
 * Extend advertised Inbox actions for plan-ready notifications. Recreating the
 * trigger upgrades databases where the advertised-actions migration already ran.
 */

const COLUMN = 'advertised_actions_json';
const VALIDATION_TRIGGER = 'notification_events_advertised_actions_insert';
const IMMUTABILITY_TRIGGER = 'notification_events_immutable_update';

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
  const immutableTrigger = await knex('sqlite_master')
    .select('sql')
    .where({ type: 'trigger', name: IMMUTABILITY_TRIGGER })
    .first();
  if (!immutableTrigger?.sql) {
    throw new Error(`Missing required trigger ${IMMUTABILITY_TRIGGER}`);
  }

  await knex.raw(`DROP TRIGGER ${IMMUTABILITY_TRIGGER}`);
  try {
    await knex.raw(`
      UPDATE notification_events AS event
      SET ${COLUMN} = (
        SELECT json_group_array(value)
        FROM (
          SELECT value
          FROM json_each(event.${COLUMN})
          WHERE value IN ('stop', 'follow_up', 'open_pr', 'dismiss')
          ORDER BY key
        )
      )
      WHERE event.${COLUMN} IS NOT NULL
    `);
  } finally {
    await knex.raw(immutableTrigger.sql);
  }
  await createValidationTrigger(knex, [
    'stop',
    'follow_up',
    'open_pr',
    'dismiss',
  ]);
}
