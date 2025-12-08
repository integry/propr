export async function up(knex) {
  await knex.schema.createTable('task_drafts', (table) => {
    table.uuid('draft_id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('user_id').notNullable();
    table.string('repository').notNullable();
    table.string('name').defaultTo('Untitled Plan');
    table.text('initial_prompt');
    table.jsonb('plan_json').defaultTo('[]');
    table.jsonb('context_config').defaultTo('{}');
    table.string('status').defaultTo('draft');
    table.timestamps(true, true);

    table.index('user_id', 'idx_task_drafts_user_id');
    table.index('repository', 'idx_task_drafts_repository');
    table.index('updated_at', 'idx_task_drafts_updated_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_drafts');
}
