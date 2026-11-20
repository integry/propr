// Plugin installation state: one row per plugin an administrator installed on
// this instance, with its enabled flag, settings, repository limit, granted
// permissions and package-server secret acknowledgements. Token and signing
// secret connections are sealed with the extension private-secret mechanism in
// their own table and erased from native exports. Management actions are kept
// in an append-only audit table that outlives an uninstall.

export async function up(knex) {
  if (!await knex.schema.hasTable('plugin_installations')) {
    await knex.schema.createTable('plugin_installations', t => {
      t.string('plugin_id').primary();
      // The manifest version installed or last approved.
      t.string('manifest_version').notNullable();
      t.boolean('enabled').notNullable().defaultTo(false);
      t.text('settings').notNullable().defaultTo('{}');
      // JSON list of owner/repo; NULL means all repositories.
      t.text('repositories');
      // JSON set of granted permissions.
      t.text('granted_permissions').notNullable().defaultTo('[]');
      // JSON map of package server name -> { actor, at, package, version, secretEnv }.
      t.text('acknowledgements').notNullable().defaultTo('{}');
      t.string('installed_by').notNullable(); t.bigInteger('installed_at').notNullable();
      t.string('updated_by').notNullable(); t.bigInteger('updated_at').notNullable();
    });
  }
  if (!await knex.schema.hasTable('plugin_secrets')) {
    await knex.schema.createTable('plugin_secrets', t => {
      t.string('plugin_id').notNullable(); t.string('connection_name').notNullable();
      t.text('sealed').notNullable();
      t.string('set_by').notNullable(); t.bigInteger('set_at').notNullable();
      t.primary(['plugin_id', 'connection_name']);
    });
  }
  if (!await knex.schema.hasTable('plugin_audit')) {
    await knex.schema.createTable('plugin_audit', t => {
      t.increments('id').primary(); t.string('plugin_id').notNullable();
      t.string('action').notNullable(); t.string('actor').notNullable(); t.bigInteger('at').notNullable();
      t.text('detail').notNullable().defaultTo('{}');
      t.index(['plugin_id', 'id']);
    });
  }
}

// Installations are customer configuration and stay on rollback; older versions ignore them.
export async function down() {}
