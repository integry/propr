export async function up(knex) {
    await knex.schema.alterTable('pr_continuations', table => {
        // Originating task, instruction comments and completion inputs survive publication retries.
        table.text('publication_completion');
    });
}

export async function down(knex) {
    await knex.schema.alterTable('pr_continuations', table => {
        table.dropColumn('publication_completion');
    });
}
