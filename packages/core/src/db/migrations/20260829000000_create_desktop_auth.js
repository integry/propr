/**
 * Device pairing requests and opaque, instance-scoped API credentials.
 *
 * Pairing secrets and API tokens are deliberately represented only by their
 * SHA-256 digests.  The plaintext values exist only in the response that hands
 * them to the desktop client.
 */
export async function up(knex) {
  await knex.schema.createTable('desktop_pairing_requests', (table) => {
    table.text('id').primary();
    table.text('device_secret_hash').notNullable();
    table.text('client_name').notNullable();
    table.text('status').notNullable().defaultTo('pending').checkIn(['pending', 'approved', 'consumed']);
    table.text('approved_by_user_id').nullable();
    table.text('approved_by_username').nullable();
    table.text('approved_by_display_name').nullable();
    table.text('approved_by_email').nullable();
    table.text('approved_by_avatar_url').nullable();
    table.timestamp('created_at').notNullable();
    table.timestamp('expires_at').notNullable();
    table.timestamp('approved_at').nullable();
    table.timestamp('consumed_at').nullable();

    table.index(['status', 'expires_at']);
  });

  await knex.schema.createTable('instance_api_tokens', (table) => {
    table.text('id').primary();
    table.text('token_hash').notNullable().unique();
    table.text('token_hint').notNullable();
    table.text('name').notNullable();
    table.text('owner_github_user_id').notNullable();
    table.text('owner_github_username').notNullable();
    table.text('owner_display_name').notNullable();
    table.text('owner_email').nullable();
    table.text('owner_avatar_url').nullable();
    table.timestamp('created_at').notNullable();
    table.timestamp('last_used_at').nullable();
    table.timestamp('expires_at').nullable();
    table.timestamp('revoked_at').nullable();
    table.text('revoked_by_user_id').nullable();

    table.index('owner_github_user_id');
    table.index(['revoked_at', 'expires_at']);
  });

  await knex.schema.createTable('desktop_auth_audit', (table) => {
    table.increments('id').primary();
    table.text('action').notNullable();
    table.text('actor_github_user_id').nullable();
    table.text('actor_github_username').nullable();
    table.text('pairing_id').nullable();
    table.text('token_id').nullable();
    table.text('client_name').nullable();
    table.timestamp('created_at').notNullable();

    table.index('created_at');
    table.index('actor_github_user_id');
    table.index('token_id');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('desktop_auth_audit');
  await knex.schema.dropTableIfExists('instance_api_tokens');
  await knex.schema.dropTableIfExists('desktop_pairing_requests');
}
