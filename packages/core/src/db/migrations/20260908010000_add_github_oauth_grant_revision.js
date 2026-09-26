/**
 * Adds comparable ordering and login-lineage revisions to the two copies of
 * an administrator's rotating GitHub OAuth grant.
 */
export async function up(knex) {
  for (const tableName of ['visual_preview_oauth_credentials', 'github_user_grants']) {
    if (await knex.schema.hasTable(tableName) && !(await knex.schema.hasColumn(tableName, 'grant_revision'))) {
      await knex.schema.alterTable(tableName, table => {
        table.bigInteger('grant_revision').notNullable().defaultTo(0);
      });
    }
    if (await knex.schema.hasTable(tableName) && !(await knex.schema.hasColumn(tableName, 'login_revision'))) {
      await knex.schema.alterTable(tableName, table => {
        table.bigInteger('login_revision').notNullable().defaultTo(0);
      });
    }
  }
}

export async function down(knex) {
  for (const tableName of ['github_user_grants', 'visual_preview_oauth_credentials']) {
    if (await knex.schema.hasTable(tableName) && await knex.schema.hasColumn(tableName, 'login_revision')) {
      await knex.schema.alterTable(tableName, table => {
        table.dropColumn('login_revision');
      });
    }
    if (await knex.schema.hasTable(tableName) && await knex.schema.hasColumn(tableName, 'grant_revision')) {
      await knex.schema.alterTable(tableName, table => {
        table.dropColumn('grant_revision');
      });
    }
  }
}
