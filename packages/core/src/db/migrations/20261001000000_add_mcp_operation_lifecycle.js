export async function up(knex) {
  await knex.schema.alterTable('mcp_operations', table => {
    table.string('lifecycle', 16).notNullable().defaultTo('accepted');
    table.bigInteger('accepted_at').notNullable().defaultTo(0);
    table.bigInteger('started_at').nullable();
    table.bigInteger('finished_at').nullable();
    table.json('failure').nullable();
    table.json('artifacts').notNullable().defaultTo('{}');
    table.json('progress').nullable();
  });
  // The previous runner inserted in-flight receipts as 'running' with no
  // result. Such a row survived a restart mid-flight; record it as an accepted
  // invocation so the interruption timeout can settle it as unknown.
  await knex('mcp_operations').update({
    state: knex.raw("CASE WHEN state = 'running' AND result IS NULL THEN 'accepted' ELSE state END"),
    lifecycle: knex.raw("CASE WHEN state IN ('completed', 'failed', 'cancelled', 'unknown') THEN state ELSE 'accepted' END"),
    accepted_at: knex.ref('created_at'),
    finished_at: knex.raw("CASE WHEN state IN ('completed', 'failed', 'cancelled') THEN updated_at ELSE NULL END"),
  });
  await knex.schema.alterTable('mcp_operations', table => {
    table.index(['owner_id', 'grant_id', 'accepted_at'], 'mcp_operations_owner_grant_accepted_idx');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('mcp_operations', table => {
    table.dropIndex(['owner_id', 'grant_id', 'accepted_at'], 'mcp_operations_owner_grant_accepted_idx');
    table.dropColumns('lifecycle', 'accepted_at', 'started_at', 'finished_at', 'failure', 'artifacts', 'progress');
  });
}
