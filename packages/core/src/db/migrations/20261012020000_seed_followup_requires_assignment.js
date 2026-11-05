/**
 * Seed the followup_requires_assignment system setting.
 * Defaults to false: turning it on changes who may start follow-up work, and
 * instances whose tasks are never assigned must not lose follow-ups on upgrade.
 */
export async function up(knex) {
  await knex('system_configs')
    .insert({
      key: 'followup_requires_assignment',
      value: JSON.stringify(false),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now()
    })
    .onConflict('key')
    .ignore();
}

export async function down(knex) {
  await knex('system_configs').where({ key: 'followup_requires_assignment' }).delete();
}
