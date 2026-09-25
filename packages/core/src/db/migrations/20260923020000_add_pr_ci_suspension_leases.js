// Cross-process mutual exclusion for one pull request's CI suspension.
// Generation-checked writes keep a stale worker from overwriting state, but
// they cannot serialize the external effects: without this lease a sweep in one
// worker can read an active suspension while another worker is already
// restarting the runs it is about to cancel again. The row is the lease; it
// carries the holder's token and an expiry so a crashed holder is taken over.
export async function up(knex) {
    await knex.schema.createTable('pr_ci_suspension_leases', table => {
        table.string('lease_key', 320).notNullable().primary();
        table.string('token', 64).notNullable();
        table.string('holder', 255);
        // Epoch milliseconds: compared against Date.now() on every backend.
        table.bigInteger('acquired_at').notNullable();
        table.bigInteger('expires_at').notNullable();
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('pr_ci_suspension_leases');
}
