/**
 * Seed the model_reasoning_level system setting.
 *
 * Empty string means use the selected agent CLI's built-in default. The insert
 * is idempotent and will not overwrite operator-customized values.
 */
export async function up(knex) {
  await knex('system_configs')
    .insert({
      key: 'model_reasoning_level',
      value: JSON.stringify(''),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now()
    })
    .onConflict('key')
    .ignore();
}

export async function down(knex) {
  await knex('system_configs').where({ key: 'model_reasoning_level' }).delete();
}
