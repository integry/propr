// Plugin handler state: a small key-value store per installed plugin
// (`ctx.state`), for cursors and mappings such as "this pull request maps to
// that chat thread". Values are JSON; `bytes` is the UTF-8 size of the stored
// value, so the per-installation size limit is one indexed sum. Rows are
// deleted when the plugin is uninstalled.

export async function up(knex) {
  if (await knex.schema.hasTable('plugin_state')) return;
  await knex.schema.createTable('plugin_state', t => {
    t.string('plugin_id').notNullable();
    t.string('state_key', 200).notNullable();
    t.text('value').notNullable();
    t.integer('bytes').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['plugin_id', 'state_key']);
  });
}

// Handler state belongs to installations, which stay on rollback; older versions ignore it.
export async function down() {}
