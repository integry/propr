// When a sweep last tried to record a pending schedule slot's run. Pending
// slots are retried least recently attempted first, so slots whose trigger
// keeps failing rotate behind the others instead of filling every batch.
export async function up(knex) {
  if (await knex.schema.hasColumn('agent_definitions', 'pending_schedule_attempted_at')) return;
  await knex.schema.alterTable('agent_definitions', table => {
    table.bigInteger('pending_schedule_attempted_at').nullable();
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasColumn('agent_definitions', 'pending_schedule_attempted_at'))) return;
  await knex.schema.alterTable('agent_definitions', table => {
    table.dropColumn('pending_schedule_attempted_at');
  });
}
