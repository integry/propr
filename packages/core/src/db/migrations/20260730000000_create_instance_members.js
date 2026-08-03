/**
 * Durable instance-level roles and their audit trail.
 *
 * GitHub's numeric user ID is the authority because usernames can change. The
 * username columns are snapshots retained for display and audit purposes.
 */
export async function up(knex) {
  await knex.schema.createTable('instance_members', (table) => {
    table.text('github_user_id').primary();
    table.text('github_username').notNullable();
    table.text('role').notNullable().checkIn(['admin', 'member']);
    table.text('source').notNullable().defaultTo('local').checkIn(['local', 'managed']);
    table.text('created_by_user_id').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('role');
    table.index('github_username');
  });

  await knex.schema.createTable('instance_role_audit', (table) => {
    table.increments('id').primary();
    table.text('actor_github_user_id').notNullable();
    table.text('actor_github_username').notNullable();
    table.text('target_github_user_id').notNullable();
    table.text('target_github_username').notNullable();
    table.text('action').notNullable();
    table.text('previous_role').nullable();
    table.text('new_role').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('created_at');
    table.index('target_github_user_id');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('instance_role_audit');
  await knex.schema.dropTableIfExists('instance_members');
}
