// The schedule slot a sweep claimed but has not recorded a run for yet. The
// claim sets it together with `next_run_at`, and it is cleared only once the
// slot's run receipt exists, so a daemon that stops in between resumes the
// slot on its next sweep instead of losing it.
export async function up(knex) {
  if (await knex.schema.hasColumn('agent_definitions', 'pending_schedule_slot')) return;
  await knex.schema.alterTable('agent_definitions', table => {
    table.bigInteger('pending_schedule_slot').nullable();
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasColumn('agent_definitions', 'pending_schedule_slot'))) return;
  await knex.schema.alterTable('agent_definitions', table => {
    table.dropColumn('pending_schedule_slot');
  });
}
