/**
 * Make desktop credentials unusable until the desktop confirms that encrypted
 * rollback material is durable. Existing active credentials remain active;
 * only credentials issued by the new pairing protocol begin provisional.
 */
export async function up(knex) {
  await knex.schema.alterTable('desktop_pairing_requests', (table) => {
    table.text('requested_instance_id').nullable();
    table.text('requested_origin').nullable();
    table.text('requested_scope').nullable();
    table.text('credential_generation').nullable();
    table.text('provisional_token_id').nullable();
    table.text('activation_ticket_hash').nullable();
    table.text('activation_receipt').nullable();
    table.timestamp('activation_expires_at').nullable();
    table.timestamp('activated_at').nullable();
    table.timestamp('cancelled_at').nullable();
  });
  await knex.schema.alterTable('instance_api_tokens', (table) => {
    table.text('activation_state').notNullable().defaultTo('active');
    table.text('pairing_id').nullable();
    table.text('bound_instance_id').nullable();
    table.text('bound_origin').nullable();
    table.text('bound_scope').nullable();
    table.text('credential_generation').nullable();
    table.index(['activation_state', 'expires_at']);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('instance_api_tokens', (table) => {
    table.dropIndex(['activation_state', 'expires_at']);
    table.dropColumns(
      'activation_state',
      'pairing_id',
      'bound_instance_id',
      'bound_origin',
      'bound_scope',
      'credential_generation',
    );
  });
  await knex.schema.alterTable('desktop_pairing_requests', (table) => {
    table.dropColumns(
      'requested_instance_id',
      'requested_origin',
      'requested_scope',
      'credential_generation',
      'provisional_token_id',
      'activation_ticket_hash',
      'activation_receipt',
      'activation_expires_at',
      'activated_at',
      'cancelled_at',
    );
  });
}
