/**
 * Requested issue retries: who asked, the comment carrying their instructions,
 * and the trigger write that publishes them.
 *
 * A request is recorded before its trigger is written and stays open until a
 * dispatch carries it into a run or it is known to be owed none, however long
 * that takes, so a recovering delivery can always tell its trigger apart. An
 * issue owes at most one open request: `owed_issue` is unique while set.
 */
export async function up(knex) {
  if (await knex.schema.hasTable('issue_retry_request_states')) return;
  await knex.schema.createTable('issue_retry_request_states', (table) => {
    table.increments('id').primary();
    table.string('repo_owner').notNullable();
    table.string('repo_name').notNullable();
    table.integer('issue_number').notNullable();
    table.string('requester_id').notNullable();
    // Set once the request is posted, before its trigger is written.
    table.bigInteger('comment_id').nullable().unique();
    table.bigInteger('actor_id').nullable();
    // When the request reserved the issue, which times the reservation only.
    table.bigInteger('requested_at').notNullable();
    // When its trigger write began, which opens the window its trigger can land in.
    table.bigInteger('published_at').nullable();
    table.string('after_event_id').nullable();
    // 'reserved' before the trigger write, 'pending' while its outcome is unknown, then 'possible' or 'refused'.
    table.string('publication', 16).notNullable();
    table.bigInteger('consumed_at').nullable();
    // The issue while the request may still be owed a run; cleared once it is known not to be.
    table.string('owed_issue').nullable().unique();
    table.bigInteger('recorded_at').notNullable();
    table.index(['repo_owner', 'repo_name', 'issue_number']);
    table.index('recorded_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('issue_retry_request_states');
}
