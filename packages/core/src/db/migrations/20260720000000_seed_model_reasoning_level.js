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
  // This migration only seeds an operator-editable setting. Rolling it back
  // must not delete a value that may have been customized after deployment.
  void knex;
}
