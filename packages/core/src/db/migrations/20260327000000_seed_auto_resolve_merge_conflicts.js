/**
 * Seed the auto_resolve_merge_conflicts system setting.
 * Defaults to false so existing deployments are unaffected until an operator
 * explicitly enables the feature.
 */
export async function up(knex) {
  await knex('system_configs')
    .insert({
      key: 'auto_resolve_merge_conflicts',
      value: JSON.stringify(false),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now()
    })
    .onConflict('key')
    .ignore();
}

export async function down(knex) {
  await knex('system_configs').where({ key: 'auto_resolve_merge_conflicts' }).delete();
}
