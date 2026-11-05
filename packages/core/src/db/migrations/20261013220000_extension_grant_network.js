export async function up(knex) {
  for (const column of ['allow_write', 'network_policy', 'request_bytes', 'network_denials', 'network_events']) {
    if (await knex.schema.hasColumn('extension_run_grants', column)) continue;
    await knex.schema.alterTable('extension_run_grants', t => {
      if (column === 'allow_write') t.boolean(column).notNullable().defaultTo(false);
      else if (column === 'network_policy') t.text(column);
      else if (column === 'network_events') t.text(column).notNullable().defaultTo('[]');
      else t.integer(column).notNullable().defaultTo(0);
    });
  }
  if (await knex.schema.hasTable('task_submissions') && !await knex.schema.hasColumn('task_submissions', 'extension_authorization')) await knex.schema.alterTable('task_submissions', t => t.text('extension_authorization'));
  // Old pending/running credentials lack a captured policy and fail closed.
  await knex('extension_run_grants').whereNull('network_policy').delete();
}
export async function down() { /* Security metadata is retained on rollback. */ }
