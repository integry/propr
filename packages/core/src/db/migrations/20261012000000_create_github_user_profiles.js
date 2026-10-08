/**
 * Cache of GitHub user profiles keyed by the stable numeric user id.
 *
 * Tasks, goals, plans, automations and to-dos store only the GitHub numeric
 * user id. This table maps that id to the login, display name and avatar URL
 * needed to render an assignee, so a task list never resolves logins against
 * GitHub on each render. `github_user_id` is a string, as everywhere else in
 * this codebase (`goals.owner_id`, `tasks.initial_job_data.userId`).
 * `refreshed_at` records when the profile was last confirmed against GitHub.
 */
export async function up(knex) {
  await knex.schema.createTable('github_user_profiles', table => {
    table.string('github_user_id', 64).primary();
    table.string('login', 255).notNullable();
    table.text('avatar_url');
    table.string('display_name', 255);
    table.text('refreshed_at').notNullable();
    table.text('created_at').notNullable();
    table.text('updated_at').notNullable();

    table.index(['login'], 'github_user_profiles_login_index');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('github_user_profiles');
}
