/**
 * Give repository indexing state its own transition identity. repositories.updated_at
 * is shared by unrelated repository metadata and cannot safely deduplicate status events.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('repositories')) return;

  const hasTransitionAt = await knex.schema.hasColumn('repositories', 'indexing_transition_at');
  const hasRunId = await knex.schema.hasColumn('repositories', 'indexing_run_id');
  await knex.schema.alterTable('repositories', (table) => {
    if (!hasTransitionAt) table.text('indexing_transition_at').nullable();
    if (!hasRunId) table.text('indexing_run_id').nullable();
  });

  if (!hasTransitionAt) {
    await knex.raw(`
      UPDATE repositories
      SET indexing_transition_at = updated_at
      WHERE indexing_transition_at IS NULL
    `);
  }
  await knex.schema.alterTable('repositories', (table) => {
    table.index(['indexing_status', 'indexing_transition_at'], 'repositories_indexing_transition_idx');
  });
}

export async function down(knex) {
  if (!await knex.schema.hasTable('repositories')) return;
  await knex.schema.alterTable('repositories', (table) => {
    table.dropIndex(['indexing_status', 'indexing_transition_at'], 'repositories_indexing_transition_idx');
  });
  const columns = [];
  if (await knex.schema.hasColumn('repositories', 'indexing_transition_at')) {
    columns.push('indexing_transition_at');
  }
  if (await knex.schema.hasColumn('repositories', 'indexing_run_id')) {
    columns.push('indexing_run_id');
  }
  if (columns.length > 0) {
    await knex.schema.alterTable('repositories', (table) => table.dropColumns(...columns));
  }
}
