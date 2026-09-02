/**
 * Operational fencing and steering for the single provider-owned goal session.
 * These records are transport state, not a ProPR planning graph.
 */
export async function up(knex) {
  await knex.schema.alterTable('goals', table => {
    table.uuid('run_claim');
    table.timestamp('claimed_at');
    table.timestamp('attempt_heartbeat_at');
    table.string('active_turn_id', 255);
    table.timestamp('pause_confirmed_at');
    table.boolean('resume_requested').notNullable().defaultTo(false);
    table.string('create_idempotency_key', 255);
    table.text('failure_reason');
    table.json('artifact_stats').defaultTo('{}');
    table.timestamp('artifacts_checked_at');
    table.unique(['owner_id', 'create_idempotency_key']);
    table.index(['desired_state', 'result_state', 'attempt_heartbeat_at']);
  });

  await knex.schema.createTable('goal_inputs', table => {
    table.increments('sequence').primary();
    table.uuid('input_id').notNullable().unique();
    table.uuid('goal_id').notNullable().references('goal_id').inTable('goals').onDelete('CASCADE');
    table.string('owner_id', 255).notNullable();
    table.string('idempotency_key', 255).notNullable();
    table.string('kind', 20).notNullable().defaultTo('input');
    table.text('message').notNullable();
    table.string('state', 20).notNullable().defaultTo('pending');
    table.integer('delivered_generation');
    table.string('delivered_claim', 255);
    table.string('delivered_turn_id', 255);
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('delivered_at');

    table.unique(['goal_id', 'owner_id', 'idempotency_key']);
    table.index(['goal_id', 'state', 'sequence']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goal_inputs');
  await knex.schema.alterTable('goals', table => {
    table.dropUnique(['owner_id', 'create_idempotency_key']);
    table.dropIndex(['desired_state', 'result_state', 'attempt_heartbeat_at']);
    table.dropColumns(
      'run_claim',
      'claimed_at',
      'attempt_heartbeat_at',
      'active_turn_id',
      'pause_confirmed_at',
      'resume_requested',
      'create_idempotency_key',
      'failure_reason',
      'artifact_stats',
      'artifacts_checked_at',
    );
  });
}
