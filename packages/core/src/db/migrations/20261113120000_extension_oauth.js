// OAuth sign-in for library MCP servers. A connection is credential state of
// one library item (instance + server name), bound to the endpoint and client
// it was made for; it is never part of a library revision. Tokens, expiry,
// granted scopes and a dynamically registered client secret are sealed with
// the extension private-secret mechanism. Pending sign-ins hold only a hash of
// their state and a sealed PKCE verifier; connect, disconnect and
// needs-sign-in transitions are kept in an append-only audit table.

export async function up(knex) {
  if (!await knex.schema.hasTable('extension_oauth_connections')) {
    await knex.schema.createTable('extension_oauth_connections', t => {
      t.uuid('instance_id').notNullable(); t.string('server_name').notNullable();
      t.text('endpoint').notNullable();
      // 'connected' or 'needs_sign_in'; no row means not connected.
      t.string('state').notNullable();
      t.string('registration').notNullable(); t.text('client_id').notNullable();
      // Public authorization server metadata used for refresh and revocation.
      t.text('issuer').notNullable(); t.text('metadata').notNullable(); t.text('redirect_uri').notNullable();
      // The resource identifier the protected resource metadata declares (RFC 9728), sent as the RFC 8707
      // `resource` on refresh. It may be a parent of the endpoint, which stays the binding for custody and routing.
      t.text('resource').notNullable();
      t.text('sealed').notNullable();
      // A fresh id per sign-in: refreshes, failures and leases of a replaced connection never touch its successor.
      t.string('generation').notNullable();
      // Optimistic concurrency of token rotation and the cross-process refresh lease, fenced on its owner.
      t.integer('version').notNullable().defaultTo(1); t.bigInteger('refresh_lease_until'); t.string('refresh_lease_owner');
      t.string('connected_by').notNullable(); t.bigInteger('connected_at').notNullable(); t.bigInteger('updated_at').notNullable();
      t.primary(['instance_id', 'server_name']);
    });
  }
  if (!await knex.schema.hasTable('extension_oauth_pending')) {
    await knex.schema.createTable('extension_oauth_pending', t => {
      t.string('state_hash').primary(); t.uuid('instance_id').notNullable(); t.string('server_name').notNullable();
      t.text('endpoint').notNullable(); t.string('actor').notNullable(); t.string('session_hash').notNullable();
      t.text('sealed').notNullable(); t.text('details').notNullable();
      t.bigInteger('expires_at').notNullable();
      // Set by the callback that consumed the state; Disconnect and binding changes delete the row to cancel it.
      t.string('claim');
    });
  }
  if (!await knex.schema.hasTable('extension_oauth_audit')) {
    await knex.schema.createTable('extension_oauth_audit', t => {
      t.increments('id').primary(); t.uuid('instance_id').notNullable(); t.string('server_name').notNullable();
      t.string('action').notNullable(); t.string('actor').notNullable(); t.bigInteger('at').notNullable();
    });
  }
}

// Connections are customer credential state and stay on rollback; older versions ignore them.
export async function down() {}
