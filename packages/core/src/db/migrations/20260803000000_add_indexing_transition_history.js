/**
 * Preserve every accepted repository indexing transition so notification
 * reconciliation can recover a terminal event after a later run takes over.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('repositories')) return;

  await knex.schema.createTable('repository_indexing_transitions', (table) => {
    table.increments('transition_id').primary();
    table.text('full_name').notNullable();
    table.text('branch').notNullable();
    table.text('run_id').notNullable();
    table.text('status').notNullable();
    table.text('transition_at').notNullable();
    table.text('observed_at').notNullable();
    table.unique(
      ['full_name', 'branch', 'run_id', 'status', 'transition_at'],
      'repository_indexing_transitions_identity_unique'
    );
    table.index(
      ['status', 'transition_id'],
      'repository_indexing_transitions_status_cursor_idx'
    );
    table.foreign(['full_name', 'branch'])
      .references(['full_name', 'branch'])
      .inTable('repositories')
      .onDelete('CASCADE');
    table.check(
      "status IN ('idle', 'indexing', 'completed', 'failed')",
      {},
      'repository_indexing_transitions_status_check'
    );
  });

  const hasRunId = await knex.schema.hasColumn('repositories', 'indexing_run_id');
  const hasTransitionAt = await knex.schema.hasColumn('repositories', 'indexing_transition_at');
  if (!hasRunId || !hasTransitionAt) return;
  await knex.raw(`
    INSERT OR IGNORE INTO repository_indexing_transitions (
      full_name, branch, run_id, status, transition_at, observed_at
    )
    SELECT
      full_name,
      branch,
      indexing_run_id,
      indexing_status,
      indexing_transition_at,
      COALESCE(updated_at, indexing_transition_at)
    FROM repositories
    WHERE indexing_run_id IS NOT NULL
      AND indexing_transition_at IS NOT NULL
      AND indexing_status IN ('idle', 'indexing', 'completed', 'failed')
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('repository_indexing_transitions');
}
