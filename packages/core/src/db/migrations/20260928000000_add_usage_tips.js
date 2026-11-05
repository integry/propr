// No earlier usage-tips migration has shipped on this branch. Timestamps are
// explicit epoch milliseconds, unlike legacy mixed SQLite timestamp columns.
export async function up(knex) {
  await knex.schema.createTable('usage_tip_selection', table => {
    table.integer('id').primary();
    table.check('id = 1');
    table.text('candidates').notNullable();
    table.text('signals').notNullable();
    table.text('model').nullable();
    table.text('source').notNullable();
    table.bigInteger('generated_at').notNullable();
    table.bigInteger('rotation_epoch').notNullable();
  });
  await knex.schema.createTable('usage_tip_dismissals', table => {
    table.string('user_id').notNullable();
    table.string('tip_id').notNullable();
    table.bigInteger('dismissed_at').notNullable();
    table.integer('dismissal_count').notNullable().defaultTo(1);
    table.check('dismissal_count >= 1');
    table.primary(['user_id', 'tip_id']);
  });
  await knex.schema.createTable('usage_tip_dismissal_events', table => {
    table.string('user_id').notNullable();
    table.string('event_id').notNullable();
    table.string('tip_id').notNullable();
    table.primary(['user_id', 'event_id']);
  });
  await knex('system_configs').insert([
    { key: 'usage_tips_enabled', value: 'true' },
    { key: 'usage_tips_dismissal_cooldown_days', value: '45' },
  ]).onConflict('key').ignore();
}
export async function down(knex) {
  await knex.schema.dropTableIfExists('usage_tip_dismissal_events');
  await knex.schema.dropTableIfExists('usage_tip_dismissals');
  await knex.schema.dropTableIfExists('usage_tip_selection');
  await knex('system_configs').whereIn('key', ['usage_tips_enabled', 'usage_tips_dismissal_cooldown_days']).delete();
}
