/**
 * Seed ultrafix and PR review system settings.
 *
 * New keys:
 *   - pr_review_model          (string, empty = use default agent model)
 *   - ultrafix_rating_goal     (number, default 7)
 *   - ultrafix_max_cycles      (number, default 5)
 *   - ultrafix_pause_seconds   (number, default 60)
 *
 * Uses INSERT … ON CONFLICT IGNORE so the migration is idempotent and
 * will not overwrite values that an operator has already customised.
 */
export async function up(knex) {
  const rows = [
    { key: 'pr_review_model',        value: JSON.stringify('') },
    { key: 'ultrafix_rating_goal',   value: JSON.stringify(7) },
    { key: 'ultrafix_max_cycles',    value: JSON.stringify(5) },
    { key: 'ultrafix_pause_seconds', value: JSON.stringify(60) },
  ];

  for (const row of rows) {
    await knex('system_configs')
      .insert({
        ...row,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now()
      })
      .onConflict('key')
      .ignore();
  }
}

export async function down(knex) {
  await knex('system_configs')
    .whereIn('key', [
      'pr_review_model',
      'ultrafix_rating_goal',
      'ultrafix_max_cycles',
      'ultrafix_pause_seconds'
    ])
    .delete();
}
