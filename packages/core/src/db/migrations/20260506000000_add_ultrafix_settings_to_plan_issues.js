/**
 * Add planner ultrafix configuration columns to plan_issues.
 */
function getClientDialect(knex) {
  return knex.client.config.client;
}

function isSQLiteDialect(client) {
  return client === 'sqlite3' || client === 'better-sqlite3';
}

function isPostgresDialect(client) {
  return client === 'pg' || client === 'postgres' || client === 'postgresql';
}

export async function up(knex) {
  const client = getClientDialect(knex);

  if (isSQLiteDialect(client)) {
    await knex.raw('ALTER TABLE plan_issues ADD COLUMN run_ultrafix boolean NULL');
    await knex.raw('ALTER TABLE plan_issues ADD COLUMN ultrafix_goal integer NULL CHECK (ultrafix_goal IS NULL OR ultrafix_goal BETWEEN 1 AND 10)');
    await knex.raw('ALTER TABLE plan_issues ADD COLUMN ultrafix_max_cycles integer NULL CHECK (ultrafix_max_cycles IS NULL OR ultrafix_max_cycles >= 1)');
    return;
  }

  if (!isPostgresDialect(client)) {
    throw new Error(`Unsupported database dialect for plan_issues ultrafix migration: ${client}. This migration currently supports SQLite and PostgreSQL only.`);
  }

  await knex.schema.alterTable('plan_issues', (table) => {
    table.boolean('run_ultrafix').nullable();
    table.integer('ultrafix_goal').nullable();
    table.integer('ultrafix_max_cycles').nullable();
  });

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

export async function down(knex) {
  const client = getClientDialect(knex);

  if (!isSQLiteDialect(client)) {
    if (!isPostgresDialect(client)) {
      throw new Error(`Unsupported database dialect for plan_issues ultrafix migration rollback: ${client}. This migration currently supports SQLite and PostgreSQL only.`);
    }

    await knex.raw('ALTER TABLE plan_issues DROP CONSTRAINT IF EXISTS chk_plan_issues_ultrafix_goal');
    await knex.raw('ALTER TABLE plan_issues DROP CONSTRAINT IF EXISTS chk_plan_issues_ultrafix_max_cycles');
  }

  await knex.schema.alterTable('plan_issues', (table) => {
    table.dropColumn('run_ultrafix');
    table.dropColumn('ultrafix_goal');
    table.dropColumn('ultrafix_max_cycles');
  });
}
