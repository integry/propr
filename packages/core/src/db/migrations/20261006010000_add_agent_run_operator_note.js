// The approver's note is stored with the approval so a retried handoff still
// uses it. Databases that applied the agent tables before this column existed
// get it here; the guard keeps a database that already has it unchanged.
export async function up(knex) {
  if (await knex.schema.hasColumn('agent_runs', 'operator_note')) return;
  await knex.schema.alterTable('agent_runs', table => {
    table.text('operator_note').nullable();
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasColumn('agent_runs', 'operator_note'))) return;
  await knex.schema.alterTable('agent_runs', table => {
    table.dropColumn('operator_note');
  });
}
