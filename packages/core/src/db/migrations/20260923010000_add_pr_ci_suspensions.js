// Ownership of PR validation runs that ProPR cancelled while a follow-up
// implementation is in progress. The row outlives the worker process so a crash
// can never leave CI suppressed: reconciliation restarts the cancelled runs for
// the still-current head, or drops the obligation once a replacement was pushed.
export async function up(knex) {
    await knex.schema.createTable('pr_ci_suspensions', table => {
        table.string('repository', 255).notNullable();
        table.integer('pull_request').notNullable();
        table.string('head_sha', 40).notNullable();
        table.string('task_id', 255).notNullable();
        table.string('correlation_id', 255);
        table.string('state', 32).notNullable().defaultTo('active');
        table.text('cancelled_runs').notNullable().defaultTo('[]');
        table.integer('attempts').notNullable().defaultTo(0);
        // Optimistic-concurrency token: every write of a row bumps it, so an
        // update or delete made from a stale read matches nothing and a newer
        // owner's state survives concurrent finalizer and recovery passes.
        table.integer('generation').notNullable().defaultTo(0);
        // Epoch milliseconds: compared against Date.now() on every backend.
        table.bigInteger('created_at').notNullable();
        table.bigInteger('updated_at').notNullable();
        table.primary(['repository', 'pull_request']);
        table.index(['task_id']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('pr_ci_suspensions');
}
