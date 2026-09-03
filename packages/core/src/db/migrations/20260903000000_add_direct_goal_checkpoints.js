/**
 * Worker-owned publication checkpoints for goals that implement directly.
 * Orchestrated goals continue to own their GitHub issue/PR artifacts.
 */
export async function up(knex) {
  await knex.schema.alterTable('goals', table => {
    table.integer('checkpoint_interval_minutes');
    table.timestamp('last_checkpoint_at');
    table.string('last_checkpoint_commit_sha', 64);
    table.integer('checkpoint_count').notNullable().defaultTo(0);
    table.text('checkpoint_error');
  });

  await knex.schema.createTable('goal_checkpoints', table => {
    table.uuid('checkpoint_id').primary();
    table.uuid('goal_id').notNullable().references('goal_id').inTable('goals').onDelete('CASCADE');
    table.string('owner_id', 255).notNullable();
    table.string('idempotency_key', 255).notNullable();
    table.string('operation', 100).notNullable();
    table.string('payload_hash', 64).notNullable();
    table.string('kind', 20).notNullable();
    table.text('commit_message');
    table.string('state', 20).notNullable().defaultTo('pending');
    table.integer('requested_generation').notNullable();
    table.string('requested_claim', 255);
    table.string('delivered_turn_id', 255);
    table.string('commit_sha', 64);
    table.integer('pr_number');
    table.text('pr_url');
    table.text('error');
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('started_at');
    table.timestamp('completed_at');

    table.unique(['owner_id', 'idempotency_key']);
    table.index(['goal_id', 'state', 'created_at']);
  });

  await knex('goals')
    .where({ launch_strategy: 'direct' })
    .whereNull('checkpoint_interval_minutes')
    .update({
      checkpoint_interval_minutes: 15,
      last_checkpoint_at: knex.raw('COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)'),
    });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goal_checkpoints');
  await knex.schema.alterTable('goals', table => {
    table.dropColumns(
      'checkpoint_interval_minutes',
      'last_checkpoint_at',
      'last_checkpoint_commit_sha',
      'checkpoint_count',
      'checkpoint_error',
    );
  });
}
