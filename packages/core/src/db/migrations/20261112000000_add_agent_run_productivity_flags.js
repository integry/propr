// Unproductive-run flags for automations. Each reported run records a
// normalised hash of its report and whether it was new, unchanged or empty;
// an acting run records how many mutating MCP operations its grant performed.
// A definition may opt in to having its schedule paused when the owner is told
// about a streak of unproductive scheduled runs; the streak whose pause was
// last carried out is recorded with it, so a pause left unfinished after the
// notification was stored is retried, and one already done is not repeated.
// Existing runs keep null flags: they were never classified.
const DEFINITION_COLUMNS = [
  ['pause_when_unproductive', table => table.boolean('pause_when_unproductive').notNullable().defaultTo(false)],
  ['unproductive_paused_streak', table => table.string('unproductive_paused_streak', 255).nullable()],
];
const RUN_COLUMNS = [
  ['report_hash', table => table.string('report_hash', 64).nullable()],
  ['report_novelty', table => table.string('report_novelty', 16).nullable()],
  ['acting_mutations', table => table.integer('acting_mutations').nullable()],
];

export async function up(knex) {
  if (await knex.schema.hasTable('agent_runs')) {
    for (const [column, add] of RUN_COLUMNS) {
      if (await knex.schema.hasColumn('agent_runs', column)) continue;
      await knex.schema.alterTable('agent_runs', table => { add(table); });
    }
  }
  if (await knex.schema.hasTable('agent_definitions')) {
    for (const [column, add] of DEFINITION_COLUMNS) {
      if (await knex.schema.hasColumn('agent_definitions', column)) continue;
      await knex.schema.alterTable('agent_definitions', table => { add(table); });
    }
  }
}

export async function down(knex) {
  if (await knex.schema.hasTable('agent_definitions')) {
    for (const [column] of [...DEFINITION_COLUMNS].reverse()) {
      if (!(await knex.schema.hasColumn('agent_definitions', column))) continue;
      await knex.schema.alterTable('agent_definitions', table => { table.dropColumn(column); });
    }
  }
  if (await knex.schema.hasTable('agent_runs')) {
    for (const [column] of [...RUN_COLUMNS].reverse()) {
      if (!(await knex.schema.hasColumn('agent_runs', column))) continue;
      await knex.schema.alterTable('agent_runs', table => { table.dropColumn(column); });
    }
  }
}
