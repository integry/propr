const IMMUTABLE_UPDATE_TRIGGER = 'notification_events_immutable_update';

/**
 * Projection identities and timestamps remain immutable, while a durable
 * post-transition replay may enrich user-facing fields that were unavailable
 * when the event was first projected.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('notification_events')) return;
  await knex.raw(`DROP TRIGGER IF EXISTS ${IMMUTABLE_UPDATE_TRIGGER}`);
  await knex.raw(`
    CREATE TRIGGER ${IMMUTABLE_UPDATE_TRIGGER}
    BEFORE UPDATE ON notification_events
    WHEN NEW.event_id IS NOT OLD.event_id
      OR NEW.deduplication_key IS NOT OLD.deduplication_key
      OR NEW.kind IS NOT OLD.kind
      OR NEW.severity IS NOT OLD.severity
      OR NEW.occurred_at IS NOT OLD.occurred_at
      OR NEW.created_at IS NOT OLD.created_at
      OR (
        NEW.target_json IS NOT OLD.target_json
        AND (
          OLD.kind IS NOT 'task'
          OR NEW.kind IS NOT 'task'
          OR json_remove(NEW.target_json, '$.prNumber')
             IS NOT json_remove(OLD.target_json, '$.prNumber')
          OR (
            json_type(OLD.target_json, '$.prNumber') IS NOT NULL
            AND json_extract(NEW.target_json, '$.prNumber')
                IS NOT json_extract(OLD.target_json, '$.prNumber')
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'notification event identity is immutable');
    END
  `);
}

export async function down(knex) {
  if (!await knex.schema.hasTable('notification_events')) return;
  await knex.raw(`DROP TRIGGER IF EXISTS ${IMMUTABLE_UPDATE_TRIGGER}`);
  await knex.raw(`
    CREATE TRIGGER ${IMMUTABLE_UPDATE_TRIGGER}
    BEFORE UPDATE ON notification_events
    BEGIN
      SELECT RAISE(ABORT, 'notification events are immutable');
    END
  `);
}
