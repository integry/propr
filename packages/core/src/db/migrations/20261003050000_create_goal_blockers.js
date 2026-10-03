/**
 * Durable, evidence-backed operator blockers raised by a goal's provider session.
 *
 * A row exists only when a provider sent an explicit structured request for a
 * person (a question or an approval). It is tied to the exact execution attempt
 * (generation, claim, session) that observed it, so a delayed event from an old
 * attempt can be fenced out and a replaced session can never revive it. A
 * confirmed pause is not stored here: the `goals` row already records it.
 *
 * `request_key` is the provider's own request identity within the session, so a
 * repeated or replayed event updates the same row instead of creating another,
 * and a row that was already resolved is never reopened.
 */
export async function up(knex) {
  await knex.schema.createTable('goal_blockers', table => {
    table.uuid('blocker_id').primary();
    table.uuid('goal_id').notNullable().references('goal_id').inTable('goals').onDelete('CASCADE');
    table.string('owner_id', 255).notNullable();
    table.string('repository', 255).notNullable();
    table.string('task_id', 255).notNullable();
    table.integer('run_generation').notNullable();
    table.string('run_claim', 255).notNullable();
    table.string('session_id', 255);
    table.string('turn_id', 255);
    table.string('provider', 50).notNullable();
    table.string('category', 20).notNullable();
    table.string('source', 100).notNullable();
    table.string('request_key', 255).notNullable();
    table.text('summary').notNullable();
    table.text('questions');
    table.text('response_actions').notNullable();
    table.string('status', 20).notNullable().defaultTo('open');
    table.string('resolution', 50);
    table.timestamp('first_observed_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('last_observed_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('resolved_at');

    table.unique(['goal_id', 'request_key']);
    table.index(['owner_id', 'status', 'repository']);
    table.index(['goal_id', 'status']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goal_blockers');
}
