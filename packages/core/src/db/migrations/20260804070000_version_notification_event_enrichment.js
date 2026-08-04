const INSERT_TRIGGER = 'notification_events_enrichment_sequence_insert_valid';
const UPDATE_TRIGGER = 'notification_events_enrichment_sequence_monotonic';

async function createSequenceTriggers(knex) {
  await knex.raw(`
    CREATE TRIGGER ${INSERT_TRIGGER}
    BEFORE INSERT ON notification_events
    WHEN typeof(NEW.enrichment_sequence) IS NOT 'integer'
      OR NEW.enrichment_sequence < 0
    BEGIN
      SELECT RAISE(ABORT, 'notification enrichment sequence is invalid');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER ${UPDATE_TRIGGER}
    BEFORE UPDATE ON notification_events
    WHEN typeof(NEW.enrichment_sequence) IS NOT 'integer'
      OR NEW.enrichment_sequence < OLD.enrichment_sequence
      OR (
        NEW.enrichment_sequence <= OLD.enrichment_sequence
        AND (
          NEW.target_json IS NOT OLD.target_json
          OR NEW.title IS NOT OLD.title
          OR NEW.body IS NOT OLD.body
          OR NEW.action_json IS NOT OLD.action_json
          OR NEW.metadata_json IS NOT OLD.metadata_json
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'notification enrichment sequence cannot regress');
    END
  `);
}

/** Fence mutable presentation enrichment against delayed, older replays. */
export async function up(knex) {
  if (!await knex.schema.hasTable('notification_events')) return;
  if (!await knex.schema.hasColumn('notification_events', 'enrichment_sequence')) {
    await knex.schema.alterTable('notification_events', (table) => {
      table.integer('enrichment_sequence').notNullable().defaultTo(0);
    });
  }
  await knex.raw(`DROP TRIGGER IF EXISTS ${INSERT_TRIGGER}`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER}`);
  await createSequenceTriggers(knex);
}

export async function down(knex) {
  if (!await knex.schema.hasTable('notification_events')) return;
  await knex.raw(`DROP TRIGGER IF EXISTS ${INSERT_TRIGGER}`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER}`);
  if (await knex.schema.hasColumn('notification_events', 'enrichment_sequence')) {
    await knex.schema.alterTable('notification_events', (table) => {
      table.dropColumn('enrichment_sequence');
    });
  }
}
