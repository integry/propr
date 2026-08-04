import { createHash } from 'node:crypto';

const CASE_INSENSITIVE_UNIQUE_INDEX = 'repositories_full_name_ci_branch_unique';

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

  await knex.raw(`
    UPDATE repositories
    SET indexing_transition_at = updated_at
    WHERE indexing_transition_at IS NULL
  `);
  await canonicalizeRepositories(knex);
  await backfillLegacyActiveRunIds(knex);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${CASE_INSENSITIVE_UNIQUE_INDEX}
    ON repositories (lower(full_name), branch)
  `);
  await knex.schema.alterTable('repositories', (table) => {
    table.index(['indexing_status', 'indexing_transition_at'], 'repositories_indexing_transition_idx');
  });
}

export async function down(knex) {
  if (!await knex.schema.hasTable('repositories')) return;
  await knex.raw(`DROP INDEX IF EXISTS ${CASE_INSENSITIVE_UNIQUE_INDEX}`);
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

function rowTransitionTime(row) {
  const value = row.indexing_transition_at ?? row.updated_at;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function canonicalizeRepositories(knex) {
  const rows = await knex('repositories').select(
    'full_name', 'branch', 'indexing_transition_at', 'updated_at'
  );
  const groups = new Map();
  for (const row of rows) {
    const canonicalName = row.full_name.trim().toLowerCase();
    const key = JSON.stringify([canonicalName, row.branch]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const [canonicalName] = JSON.parse(key);
    group.sort((left, right) => rowTransitionTime(right) - rowTransitionTime(left)
      || left.full_name.localeCompare(right.full_name));
    const [winner, ...duplicates] = group;
    for (const duplicate of duplicates) {
      await knex('repositories').where({
        full_name: duplicate.full_name,
        branch: duplicate.branch,
      }).delete();
    }
    if (winner.full_name !== canonicalName) {
      await knex('repositories').where({
        full_name: winner.full_name,
        branch: winner.branch,
      }).update({ full_name: canonicalName });
    }
  }
}

async function backfillLegacyActiveRunIds(knex) {
  const activeRows = await knex('repositories')
    .whereRaw('lower(indexing_status) = ?', ['indexing'])
    .whereNull('indexing_run_id')
    .select('full_name', 'branch', 'indexing_transition_at');
  for (const row of activeRows) {
    const runId = `legacy-${createHash('sha256')
      .update(`${row.full_name}\0${row.branch}\0${row.indexing_transition_at ?? ''}`)
      .digest('hex')}`;
    await knex('repositories').where({
      full_name: row.full_name,
      branch: row.branch,
    }).whereNull('indexing_run_id').update({ indexing_run_id: runId });
  }
}
