// The usage tip dismissal cooldown is now a fixed period, so its setting is gone.
export async function up(knex) {
  await knex('system_configs').where({ key: 'usage_tips_dismissal_cooldown_days' }).delete();
}
export async function down(knex) {
  await knex('system_configs').insert({ key: 'usage_tips_dismissal_cooldown_days', value: '45' }).onConflict('key').ignore();
}
