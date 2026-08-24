/** Persist whether a user wants unread Web Push deliveries to badge the app. */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

async function createTouchTrigger(knex, includeBadge) {
  await knex.raw('DROP TRIGGER IF EXISTS notification_preference_settings_touch_updated_at');
  const managedTimestamp = `CASE
    WHEN ${ISO_NOW_SQL} > OLD.updated_at THEN ${ISO_NOW_SQL}
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+0.001 seconds')
  END`;
  const columns = [
    'user_id',
    'quiet_hours_start',
    'quiet_hours_end',
    'timezone',
    ...(includeBadge ? ['badge_enabled'] : []),
    'created_at',
  ].join(', ');
  await knex.raw(`
    CREATE TRIGGER notification_preference_settings_touch_updated_at
    AFTER UPDATE OF ${columns}
    ON notification_preference_settings
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE notification_preference_settings
      SET updated_at = ${managedTimestamp}
      WHERE user_id = NEW.user_id;
    END
  `);
}

export async function up(knex) {
  if (!(await knex.schema.hasColumn('notification_preference_settings', 'badge_enabled'))) {
    await knex.schema.alterTable('notification_preference_settings', (table) => {
      table.boolean('badge_enabled').notNullable().defaultTo(true);
    });
  }
  await createTouchTrigger(knex, true);
}

export async function down(knex) {
  if (await knex.schema.hasColumn('notification_preference_settings', 'badge_enabled')) {
    await knex.raw('DROP TRIGGER IF EXISTS notification_preference_settings_touch_updated_at');
    await knex.schema.alterTable('notification_preference_settings', (table) => {
      table.dropColumn('badge_enabled');
    });
  }
  await createTouchTrigger(knex, false);
}
