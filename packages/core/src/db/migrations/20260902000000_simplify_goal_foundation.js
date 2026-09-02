/**
 * Guard the unreleased goal foundation against obsolete branch schemas.
 *
 * The edited 20260831000000 migration is the only canonical schema. This
 * migration must not rebuild tables or infer how sibling migrations should be
 * converted: merge this foundation correction first, then rebase #2059 and
 * #2065 onto it and update their event writers and provider-session calls.
 */

const LEGACY_TABLES = ['goal_nodes', 'goal_node_dependencies'];
const CANONICAL_COLUMNS = [
  ['goal_events', 'source'],
  ['goal_provider_sessions', 'native_status'],
  ['goal_provider_sessions', 'requested_model'],
];

export async function up(knex) {
  const unsupported = [];
  if (!await knex.schema.hasTable('goals')) unsupported.push('missing goals table');

  for (const table of LEGACY_TABLES) {
    if (await knex.schema.hasTable(table)) unsupported.push(`legacy ${table} table`);
  }
  for (const [table, column] of CANONICAL_COLUMNS) {
    if (!await knex.schema.hasTable(table)) {
      unsupported.push(`missing ${table} table`);
    } else if (!await knex.schema.hasColumn(table, column)) {
      unsupported.push(`missing ${table}.${column}`);
    }
  }
  const eventTable = await knex('sqlite_master')
    .where({ type: 'table', name: 'goal_events' })
    .first('sql');
  if (eventTable && !/check\s*\(\s*`?source`?\s+in\s*\(\s*'internal'\s*,\s*'provider'\s*\)\s*\)/i
    .test(eventTable.sql)) {
    unsupported.push('unconstrained goal_events.source');
  }

  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported unreleased goal branch schema (${unsupported.join(', ')}). `
      + 'Apply the corrected foundation first, then rebase #2059 and #2065 onto it.'
    );
  }
}

export async function down() {
  // The canonical foundation migration owns the schema and its rollback.
}
