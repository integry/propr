// Plugin inbound webhooks: one installation key per installed plugin.
//
// The key is the unguessable segment of the plugin's webhook URLs
// (`/api/plugins/<key>/hooks/<name>`). Requests are looked up by `key_hash`
// (SHA-256 of the key); `key` itself is kept so administrators can copy the
// URL from the Plugins page. `installed_at` binds the key to one
// installation: a reinstall gets a new one. Regenerating replaces the row, so
// the old URL stops working at once.
//
// `rejected_count`, `last_rejected_at` and `last_rejected_reason` count
// requests that failed verification. Request bodies and signature headers are
// never stored, here or anywhere else.
//
// A webhook delivery's request is held only in the memory of the API process
// that accepted it. `plugin_deliveries.webhook_owner` names that process's
// webhook runner, and `plugin_webhook_runners` holds each live runner's
// heartbeat: another process fails an unfinished webhook delivery only once its
// owner's heartbeat has lapsed (or it has no owner).

export async function up(knex) {
  if (!await knex.schema.hasTable('plugin_webhook_keys')) await knex.schema.createTable('plugin_webhook_keys', t => {
    t.string('plugin_id').primary();
    t.bigInteger('installed_at').notNullable();
    t.string('key_hash', 64).notNullable().unique();
    t.string('key', 64).notNullable();
    t.string('created_by').notNullable();
    t.bigInteger('created_at').notNullable();
    t.integer('rejected_count').notNullable().defaultTo(0);
    t.bigInteger('last_rejected_at');
    t.string('last_rejected_reason');
  });
  if (!await knex.schema.hasTable('plugin_webhook_runners')) {
    await knex.schema.createTable('plugin_webhook_runners', t => {
      t.string('owner').primary();
      t.bigInteger('heartbeat_at').notNullable();
    });
  }
  if (await knex.schema.hasTable('plugin_deliveries') && !await knex.schema.hasColumn('plugin_deliveries', 'webhook_owner')) {
    await knex.schema.alterTable('plugin_deliveries', t => { t.string('webhook_owner'); });
  }
}

// Webhook keys belong to installations, which stay on rollback; older versions ignore them.
export async function down() {}
