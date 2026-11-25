export async function up(knex) {
    await knex.schema.alterTable('llm_executions', table => table.bigInteger('compute_queue_ms').nullable());
}

export async function down(knex) {
    await knex.schema.alterTable('llm_executions', table => table.dropColumn('compute_queue_ms'));
}
