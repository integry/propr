// Extension library: one instance-wide revision stream of MCP servers and skill
// bundle references, replacing extension profiles. Profile tables stay in place
// and readable; the application-level startup migration copies their items
// into the library, records the legacy profile mapping and the completion
// marker. Run grants may now bind a library revision instead of a profile.

const GRANT_COLUMNS = ['token_hash', 'profile_id', 'active', 'connections', 'revision', 'actor', 'task_id', 'expires_at', 'calls', 'bytes', 'allow_write', 'network_policy', 'request_bytes', 'network_denials', 'network_events'];

export async function up(knex) {
  if (!await knex.schema.hasTable('extension_instance_identity')) return;
  if (!await knex.schema.hasTable('extension_library')) {
    await knex.schema.createTable('extension_library', t => {
      t.uuid('instance_id').primary(); t.integer('revision').notNullable();
    });
  }
  if (!await knex.schema.hasTable('extension_library_revisions')) {
    await knex.schema.createTable('extension_library_revisions', t => {
      t.uuid('instance_id').notNullable(); t.integer('revision').notNullable();
      t.text('snapshot').notNullable(); t.text('secrets_encrypted').notNullable();
      t.primary(['instance_id', 'revision']);
    });
  }
  if (!await knex.schema.hasTable('extension_legacy_profile_items')) {
    // Old profile id -> migrated library item names, for queued New Task submissions.
    await knex.schema.createTable('extension_legacy_profile_items', t => {
      t.uuid('profile_id').primary(); t.text('servers').notNullable(); t.text('skills').notNullable();
    });
  }
  if (!await knex.schema.hasTable('extension_library_migration')) {
    await knex.schema.createTable('extension_library_migration', t => {
      t.integer('id').primary(); t.bigInteger('completed_at').notNullable(); t.text('report').notNullable();
    });
  }
  if (await knex.schema.hasTable('agent_definitions') && !await knex.schema.hasColumn('agent_definitions', 'extensions')) {
    await knex.schema.alterTable('agent_definitions', t => { t.text('extensions'); });
  }
  if (await knex.schema.hasTable('extension_run_grants') && !await knex.schema.hasColumn('extension_run_grants', 'selection')) {
    // Library grants carry no profile; rebuild so profile_id is optional and
    // existing (profile) grants of running tasks survive the upgrade.
    const present = [];
    for (const column of GRANT_COLUMNS) if (await knex.schema.hasColumn('extension_run_grants', column)) present.push(column);
    await knex.schema.createTable('extension_run_grants_next', t => {
      t.string('token_hash').primary(); t.uuid('profile_id');
      t.boolean('active').notNullable().defaultTo(false); t.integer('connections').notNullable().defaultTo(0);
      t.integer('revision').notNullable(); t.string('actor').notNullable(); t.string('task_id').notNullable();
      t.bigInteger('expires_at').notNullable(); t.integer('calls').notNullable().defaultTo(0); t.integer('bytes').notNullable().defaultTo(0);
      t.boolean('allow_write').notNullable().defaultTo(false); t.text('network_policy');
      t.integer('request_bytes').notNullable().defaultTo(0); t.integer('network_denials').notNullable().defaultTo(0);
      t.text('network_events').notNullable().defaultTo('[]');
      // Library grants: the resolved server names and skill bundle ids of the run.
      t.text('selection');
    });
    const columns = present.map(c => `"${c}"`).join(', ');
    await knex.raw(`INSERT INTO extension_run_grants_next (${columns}) SELECT ${columns} FROM extension_run_grants`);
    await knex.schema.dropTable('extension_run_grants');
    await knex.schema.renameTable('extension_run_grants_next', 'extension_run_grants');
  }
}

// Library revisions are customer data and stay on rollback; older versions ignore them.
export async function down() {}
