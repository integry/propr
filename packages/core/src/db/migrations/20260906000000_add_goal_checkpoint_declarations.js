/** Store the agent-declared scope and handoff summary for direct-goal checkpoints. */
export async function up(knex) {
  await knex.schema.alterTable('goal_checkpoints', table => {
    table.text('include_paths');
    table.text('exclude_paths');
    table.text('summary');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('goal_checkpoints', table => {
    table.dropColumns('include_paths', 'exclude_paths', 'summary');
  });
}
