export async function up(knex) {
  await knex.schema.createTable('task_submissions', table => {
    table.uuid('id').primary();
    table.string('user_id').notNullable();
    table.string('submission_key').notNullable();
    table.string('payload_hash').notNullable();
    table.string('repository').notNullable();
    table.text('payload').notNullable();
    table.text('attachments').notNullable().defaultTo('[]');
    table.string('state').notNullable().defaultTo('prepared');
    table.integer('issue_number');
    table.text('issue_url');
    table.string('task_id');
    table.string('retry_event_id');
    table.boolean('dispatch_complete').notNullable().defaultTo(false);
    table.text('error');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'submission_key']);
    table.unique(['repository', 'issue_number']);
  });
}
export async function down(knex) { await knex.schema.dropTable('task_submissions'); }
