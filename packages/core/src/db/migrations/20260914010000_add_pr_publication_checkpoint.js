export async function up(knex) {
    await knex.schema.alterTable('pr_continuations', table => {
        // A portable incremental Git bundle survives worktree cleanup and worker changes.
        table.text('publication_bundle');
    });
}

export async function down(knex) {
    await knex.schema.alterTable('pr_continuations', table => {
        table.dropColumn('publication_bundle');
    });
}
