export async function up(knex) {
    await knex.schema.createTable('pr_continuations', table => {
        table.string('repository', 255).notNullable();
        table.integer('source_pr').notNullable();
        table.string('source_sha', 40).notNullable();
        table.string('base_branch', 255).notNullable();
        table.string('branch_name', 255).notNullable();
        table.text('source_title').notNullable();
        table.text('source_body').notNullable();
        table.string('source_author', 255).notNullable();
        table.integer('continuation_pr');
        table.text('continuation_url');
        table.bigInteger('comment_id');
        table.primary(['repository', 'source_pr']);
        table.unique(['repository', 'branch_name']);
        table.unique(['repository', 'continuation_pr']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('pr_continuations');
}
