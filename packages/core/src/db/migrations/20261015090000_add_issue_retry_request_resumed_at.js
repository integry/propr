/**
 * When a follow-up restarted a requested issue retry whose trigger write's
 * outcome was lost. A restarted request may own the trigger its lost write
 * published, so it stays owed until a run carries it.
 */
export async function up(knex) {
  if (await knex.schema.hasColumn('issue_retry_request_states', 'resumed_at')) return;
  await knex.schema.alterTable('issue_retry_request_states', (table) => {
    table.bigInteger('resumed_at').nullable();
  });
}

export async function down(knex) {
  if (!await knex.schema.hasColumn('issue_retry_request_states', 'resumed_at')) return;
  await knex.schema.alterTable('issue_retry_request_states', (table) => {
    table.dropColumn('resumed_at');
  });
}
