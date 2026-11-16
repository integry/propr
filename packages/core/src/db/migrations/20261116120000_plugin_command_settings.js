// Plugin slash commands: write access, shared command owners, write grants and command deliveries.
//
// `plugin_command_settings` holds, per installed plugin and command, the
// administrator switch "Allow this command to use write access" of a command
// with `needsWrite`. No row means off. Uninstalling deletes the plugin's rows.
//
// `plugin_shared_command_owners` is the instance setting of a `shared` command
// name (for example `deploy`): the plugin whose command the plain name runs
// when several enabled plugins offer it. No row means no choice was made.
//
// `plugin_command_write_grants` records each explicit write authorization of
// one `needsWrite` command run: created when the command is accepted (the
// switch is on and the commenter has write permission), and consumed once by
// the run it was made for. A retry of that run or a later follow-up finds it
// consumed and gets read servers only. Rows expire; nothing secret is stored.
//
// `plugin_deliveries.command_input` holds a `handler` command delivery's
// comment context (repository, number, target, commenter, comment id and the
// argument) as JSON, so the delivery can be attempted again after a restart.

export async function up(knex) {
  if (!await knex.schema.hasTable('plugin_command_settings')) {
    await knex.schema.createTable('plugin_command_settings', t => {
      t.string('plugin_id').notNullable();
      t.string('command').notNullable();
      t.boolean('allow_write').notNullable().defaultTo(false);
      t.string('updated_by').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['plugin_id', 'command']);
    });
  }
  if (!await knex.schema.hasTable('plugin_shared_command_owners')) {
    await knex.schema.createTable('plugin_shared_command_owners', t => {
      t.string('command').primary();
      t.string('plugin_id').notNullable();
      t.string('set_by').notNullable();
      t.bigInteger('set_at').notNullable();
    });
  }
  if (!await knex.schema.hasTable('plugin_command_write_grants')) {
    await knex.schema.createTable('plugin_command_write_grants', t => {
      t.string('id', 64).primary();
      t.string('plugin_id').notNullable();
      t.string('command').notNullable();
      t.string('repository').notNullable();
      t.integer('number').notNullable();
      t.string('actor').notNullable();
      t.text('servers').notNullable().defaultTo('[]');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('consumed_at');
      t.string('consumed_by');
      t.index(['expires_at']);
    });
  }
  if (await knex.schema.hasTable('plugin_deliveries') && !await knex.schema.hasColumn('plugin_deliveries', 'command_input')) {
    await knex.schema.alterTable('plugin_deliveries', t => { t.text('command_input'); });
  }
}

// Command settings belong to installations, which stay on rollback; older versions ignore them.
export async function down() {}
