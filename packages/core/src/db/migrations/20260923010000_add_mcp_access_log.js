export async function up(knex) {
  await knex.schema.createTable('mcp_access_log', table => {
    table.increments('id').primary();
    // Epoch milliseconds, matching mcp_operations. Every admin query is ordered
    // or windowed by this column, so it carries its own index as well.
    table.bigInteger('occurred_at').notNullable().index();
    table.string('owner_id', 64).nullable();
    table.string('grant_id', 128).nullable();
    table.string('client_id', 255).nullable();
    table.string('client_name', 255).nullable();
    table.string('membership_source', 32).nullable();
    // tool | resource | prompt | auth
    table.string('kind', 16).notNullable();
    // Tool, resource or prompt name. Never an argument or payload value.
    table.string('name', 128).notNullable();
    table.string('repository', 255).nullable();
    table.string('scope', 32).nullable();
    table.boolean('read_only').notNullable().defaultTo(false);
    table.integer('status').notNullable();
    // success | denied | error
    table.string('outcome', 16).notNullable();
    // Stable McpError code only; free-text messages are never stored.
    table.string('error_code', 64).nullable();
    table.integer('duration_ms').notNullable().defaultTo(0);
    table.integer('result_bytes').notNullable().defaultTo(0);
    table.uuid('operation_id').nullable();
    table.string('protocol_version', 32).nullable();
    table.string('request_id', 128).nullable();
    table.index(['owner_id', 'occurred_at']);
    table.index(['repository', 'occurred_at']);
    table.index(['name', 'occurred_at']);
    // Connected-apps rows read last-seen and recent counts per grant.
    table.index(['grant_id', 'occurred_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('mcp_access_log');
}
