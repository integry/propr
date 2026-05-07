/**
 * Add planner ultrafix configuration columns to plan_issues.
 */
export async function up(knex) {
  const isSQLite = knex.client.config.client === 'sqlite3' || knex.client.config.client === 'better-sqlite3';

  await knex.schema.alterTable('plan_issues', (table) => {
    table.boolean('run_ultrafix').nullable();
    table.integer('ultrafix_goal').nullable();
    table.integer('ultrafix_max_cycles').nullable();
  });

  if (!isSQLite) {
    await knex.raw(`
      ALTER TABLE plan_issues
      ADD CONSTRAINT chk_plan_issues_ultrafix_goal
      CHECK (ultrafix_goal IS NULL OR ultrafix_goal BETWEEN 1 AND 10)
    `);
    await knex.raw(`
      ALTER TABLE plan_issues
      ADD CONSTRAINT chk_plan_issues_ultrafix_max_cycles
      CHECK (ultrafix_max_cycles IS NULL OR ultrafix_max_cycles >= 1)
    `);
  }
}

export async function down(knex) {
  const isSQLite = knex.client.config.client === 'sqlite3' || knex.client.config.client === 'better-sqlite3';

  if (!isSQLite) {
    await knex.raw('ALTER TABLE plan_issues DROP CONSTRAINT IF EXISTS chk_plan_issues_ultrafix_goal');
    await knex.raw('ALTER TABLE plan_issues DROP CONSTRAINT IF EXISTS chk_plan_issues_ultrafix_max_cycles');
  }

  await knex.schema.alterTable('plan_issues', (table) => {
    table.dropColumn('run_ultrafix');
    table.dropColumn('ultrafix_goal');
    table.dropColumn('ultrafix_max_cycles');
  });
}
