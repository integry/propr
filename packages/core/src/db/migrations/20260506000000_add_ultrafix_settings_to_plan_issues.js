/**
 * Add planner ultrafix configuration columns to plan_issues.
 */
export async function up(knex) {
  await knex.schema.alterTable('plan_issues', (table) => {
    table.boolean('run_ultrafix').nullable();
    table.integer('ultrafix_goal').nullable();
    table.integer('ultrafix_max_cycles').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('plan_issues', (table) => {
    table.dropColumn('run_ultrafix');
    table.dropColumn('ultrafix_goal');
    table.dropColumn('ultrafix_max_cycles');
  });
}
