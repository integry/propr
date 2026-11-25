const columns = ['compute_provisioning_ms', 'compute_restore_ms'];

export async function up(knex) {
    for (const name of columns) {
        if (!await knex.schema.hasColumn('llm_executions', name)) {
            await knex.schema.alterTable('llm_executions', table => table.bigInteger(name).nullable());
        }
    }
}

export async function down(knex) {
    for (const name of columns) {
        if (await knex.schema.hasColumn('llm_executions', name)) {
            await knex.schema.alterTable('llm_executions', table => table.dropColumn(name));
        }
    }
}
