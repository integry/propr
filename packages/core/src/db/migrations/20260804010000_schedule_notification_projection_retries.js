const RETRY_TABLE = 'notification_projection_retries';
const OLD_INDEX = 'notification_projection_retries_scan_idx';
const DUE_INDEX = 'notification_projection_retries_due_idx';

/** Persist retry due-times so permanently deferred projections are not hot-polled. */
export async function up(knex) {
  if (!await knex.schema.hasTable(RETRY_TABLE)) return;
  if (!await knex.schema.hasColumn(RETRY_TABLE, 'next_attempt_at')) {
    await knex.schema.alterTable(RETRY_TABLE, (table) => {
      table.text('next_attempt_at').nullable();
    });
    await knex(RETRY_TABLE).whereNull('next_attempt_at').update({
      next_attempt_at: knex.ref('updated_at'),
    });
  }
  await knex.raw(`DROP INDEX IF EXISTS ${OLD_INDEX}`);
  await knex.schema.alterTable(RETRY_TABLE, (table) => {
    table.index(
      ['next_attempt_at', 'attempt_count', 'updated_at', 'source', 'transition_key'],
      DUE_INDEX
    );
  });
}

export async function down(knex) {
  if (!await knex.schema.hasTable(RETRY_TABLE)) return;
  await knex.raw(`DROP INDEX IF EXISTS ${DUE_INDEX}`);
  if (await knex.schema.hasColumn(RETRY_TABLE, 'next_attempt_at')) {
    await knex.schema.alterTable(RETRY_TABLE, (table) => {
      table.dropColumn('next_attempt_at');
    });
  }
  await knex.schema.alterTable(RETRY_TABLE, (table) => {
    table.index(
      ['attempt_count', 'updated_at', 'source', 'transition_key'],
      OLD_INDEX
    );
  });
}
