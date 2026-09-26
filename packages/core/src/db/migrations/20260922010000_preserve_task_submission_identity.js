export async function up(knex) {
  await knex.schema.alterTable('task_submissions', table => {
    table.string('dispatch_claim');
    table.string('latest_task_id');
  });
  await knex('task_submissions').update({ latest_task_id: knex.ref('task_id') });
}

export async function down(knex) {
  await knex.schema.alterTable('task_submissions', table => {
    table.dropColumn('dispatch_claim');
    table.dropColumn('latest_task_id');
  });
}
