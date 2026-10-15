/**
 * Durable state of a requested issue retry, keyed by its posted comment.
 *
 * The request itself is held in Redis, which is also what fails when the
 * outcome of its trigger write cannot be recorded. Recording that outcome, and
 * the dispatch that consumed the request, here lets recovery tell a published
 * request from a refused or already dispatched one across a Redis failure.
 */
export async function up(knex) {
  if (await knex.schema.hasTable('issue_retry_request_states')) return;
  await knex.schema.createTable('issue_retry_request_states', (table) => {
    table.bigInteger('comment_id').primary();
    // 'possible' when the trigger write was applied or may still be; 'refused' when GitHub refused it.
    table.string('publication', 16).nullable();
    table.bigInteger('consumed_at').nullable();
    table.bigInteger('recorded_at').notNullable();
    table.index('recorded_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('issue_retry_request_states');
}
