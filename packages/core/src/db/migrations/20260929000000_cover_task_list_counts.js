/** Cover task identity/type counts without scanning the wide task payload rows. */
export async function up(knex) {
  await knex.raw(`CREATE INDEX tasks_repository_type_identity_index
    ON tasks(repository, task_type, task_id)`);
  // The composite index retains repository-prefix lookup support.
  await knex.raw('DROP INDEX tasks_repository_index');
}

export async function down(knex) {
  await knex.raw('CREATE INDEX tasks_repository_index ON tasks(repository)');
  await knex.raw('DROP INDEX tasks_repository_type_identity_index');
}
