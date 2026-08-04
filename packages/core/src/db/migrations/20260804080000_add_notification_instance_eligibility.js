/** Current authenticated-user observations used to fence system notifications. */
export async function up(knex) {
  if (await knex.schema.hasTable('notification_instance_user_eligibility')) return;
  await knex.schema.createTable('notification_instance_user_eligibility', (table) => {
    table.text('user_id').primary();
    table.text('github_username').notNullable();
    table.text('last_authorized_at').notNullable();
    table.index(
      ['last_authorized_at', 'user_id'],
      'notification_instance_user_eligibility_current_idx'
    );
    table.check(
      'length(trim(user_id)) BETWEEN 1 AND 255 '
        + 'AND length(trim(github_username)) BETWEEN 1 AND 255',
      {},
      'notification_instance_user_eligibility_identity_check'
    );
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('notification_instance_user_eligibility');
}
