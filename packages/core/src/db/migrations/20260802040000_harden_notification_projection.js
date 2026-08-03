const SOURCE_TOUCH_TRIGGER = 'notification_source_activity_touch_updated_at';
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

function sourceManagedTimestamp() {
  return `CASE
    WHEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') > OLD.updated_at
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+0.001 seconds')
  END`;
}

async function createSourceTouchTrigger(knex, includeHardenedColumns) {
  const extraColumns = includeHardenedColumns ? ', process_heartbeat_at, stalled_notified_at' : '';
  await knex.raw(`
    CREATE TRIGGER ${SOURCE_TOUCH_TRIGGER}
    AFTER UPDATE OF activity_type, activity_key, repository, branch, status,
      last_activity_at, completed_at, metadata_json, created_at${extraColumns}
    ON notification_source_activity
    WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE notification_source_activity
      SET updated_at = ${sourceManagedTimestamp()}
      WHERE activity_type = NEW.activity_type AND activity_key = NEW.activity_key;
    END
  `);
}

function parsePreferenceMap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function backfillRepositorySubscriptions(knex) {
  if (!await knex.schema.hasTable('system_configs')) return;
  const rows = await knex('system_configs').select('key', 'value').whereLike('key', 'user_repo_prefs_%');
  const now = new Date().toISOString();
  const subscriptions = [];
  for (const row of rows) {
    if (!row.key.startsWith('user_repo_prefs_')) continue;
    const userId = row.key.slice('user_repo_prefs_'.length).trim();
    if (!userId || userId.length > 255) continue;
    for (const [repository, preference] of Object.entries(parsePreferenceMap(row.value))) {
      const normalizedRepository = repository.trim();
      if (normalizedRepository.length > 255 || !REPOSITORY_PATTERN.test(normalizedRepository)
          || !preference || typeof preference !== 'object' || Array.isArray(preference)) continue;
      subscriptions.push({
        user_id: userId,
        repository: normalizedRepository,
        hidden: preference.hidden === true,
        updated_at: now
      });
    }
  }
  for (let offset = 0; offset < subscriptions.length; offset += 200) {
    await knex('notification_repository_subscriptions')
      .insert(subscriptions.slice(offset, offset + 200))
      .onConflict(['user_id', 'repository'])
      .merge(['hidden', 'updated_at']);
  }
}

export async function up(knex) {
  await knex.schema.createTable('notification_repository_entitlements', (table) => {
    table.text('user_id').notNullable();
    table.text('repository').notNullable();
    table.text('verified_at').notNullable();
    table.text('expires_at').notNullable();
    table.primary(['user_id', 'repository']);
    table.index(['repository', 'expires_at', 'user_id'], 'notification_repository_entitlements_current_idx');
    table.check("length(trim(user_id)) BETWEEN 1 AND 255", {}, 'notification_repository_entitlements_user_check');
    table.check("length(trim(repository)) BETWEEN 3 AND 255 AND instr(repository, '/') > 1", {}, 'notification_repository_entitlements_repository_check');
    table.check('expires_at > verified_at', {}, 'notification_repository_entitlements_expiry_check');
  });
  await knex.schema.createTable('notification_repository_entitlement_snapshots', (table) => {
    table.text('user_id').primary();
    table.text('verified_at').notNullable();
    table.text('expires_at').notNullable();
    table.index('expires_at', 'notification_repository_entitlement_snapshots_expiry_idx');
    table.check("length(trim(user_id)) BETWEEN 1 AND 255", {}, 'notification_repository_entitlement_snapshots_user_check');
    table.check('expires_at > verified_at', {}, 'notification_repository_entitlement_snapshots_expiry_check');
  });
  await knex.schema.createTable('notification_repository_subscriptions', (table) => {
    table.text('user_id').notNullable();
    table.text('repository').notNullable();
    table.boolean('hidden').notNullable().defaultTo(false);
    table.text('updated_at').notNullable();
    table.primary(['user_id', 'repository']);
    table.index(['repository', 'hidden', 'user_id'], 'notification_repository_subscriptions_lookup_idx');
    table.check("length(trim(user_id)) BETWEEN 1 AND 255", {}, 'notification_repository_subscriptions_user_check');
    table.check("length(trim(repository)) BETWEEN 3 AND 255 AND instr(repository, '/') > 1", {}, 'notification_repository_subscriptions_repository_check');
    table.check('hidden IN (0, 1)', {}, 'notification_repository_subscriptions_hidden_check');
  });
  await backfillRepositorySubscriptions(knex);

  if (await knex.schema.hasTable('notification_source_activity')) {
    const hasProcessHeartbeat = await knex.schema.hasColumn('notification_source_activity', 'process_heartbeat_at');
    const hasStalledNotified = await knex.schema.hasColumn('notification_source_activity', 'stalled_notified_at');
    await knex.raw(`DROP TRIGGER IF EXISTS ${SOURCE_TOUCH_TRIGGER}`);
    await knex.schema.alterTable('notification_source_activity', (table) => {
      if (!hasProcessHeartbeat) table.text('process_heartbeat_at').nullable();
      if (!hasStalledNotified) table.text('stalled_notified_at').nullable();
    });
    await knex.schema.alterTable('notification_source_activity', (table) => {
      table.index(['status', 'last_activity_at', 'stalled_notified_at'], 'notification_source_activity_unnotified_stalled_idx');
    });
    await createSourceTouchTrigger(knex, true);
  }
  if (await knex.schema.hasTable('task_drafts')) {
    if (!await knex.schema.hasColumn('task_drafts', 'review_transition_at')) {
      await knex.schema.alterTable('task_drafts', (table) => table.text('review_transition_at').nullable());
      await knex('task_drafts').where({ status: 'review' }).whereNull('review_transition_at')
        .update({ review_transition_at: knex.ref('updated_at') });
    }
  }
}

export async function down(knex) {
  if (await knex.schema.hasTable('task_drafts')
      && await knex.schema.hasColumn('task_drafts', 'review_transition_at')) {
    await knex.schema.alterTable('task_drafts', (table) => table.dropColumn('review_transition_at'));
  }
  if (await knex.schema.hasTable('notification_source_activity')) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${SOURCE_TOUCH_TRIGGER}`);
    await knex.schema.alterTable('notification_source_activity', (table) => {
      table.dropIndex(['status', 'last_activity_at', 'stalled_notified_at'], 'notification_source_activity_unnotified_stalled_idx');
    });
    const columns = [];
    if (await knex.schema.hasColumn('notification_source_activity', 'process_heartbeat_at')) columns.push('process_heartbeat_at');
    if (await knex.schema.hasColumn('notification_source_activity', 'stalled_notified_at')) columns.push('stalled_notified_at');
    if (columns.length > 0) await knex.schema.alterTable('notification_source_activity', (table) => table.dropColumns(...columns));
    await createSourceTouchTrigger(knex, false);
  }
  await knex.schema.dropTableIfExists('notification_repository_subscriptions');
  await knex.schema.dropTableIfExists('notification_repository_entitlement_snapshots');
  await knex.schema.dropTableIfExists('notification_repository_entitlements');
}
