/**
 * Durable follow-up execution/publication handoffs. One row per follow-up
 * attempt, written before its agent starts and advanced through commit, push,
 * result-comment publication and cleanup. A worker restart leaves the row
 * open, so a later delivery can distinguish a still-live agent container from
 * vanished work, adopt the retained worktree and finish publication instead of
 * stranding the branch behind "Existing worktree retained; branch is in use".
 */
export async function up(knex) {
    if (await knex.schema.hasTable('followup_publication_handoffs')) return;
    await knex.schema.createTable('followup_publication_handoffs', table => {
        table.string('task_id', 255).primary();
        // owner/repo, lowercase, matching pr_continuations.repository.
        table.string('repository', 255).notNullable();
        table.integer('pull_request_number').notNullable();
        table.string('branch_name', 255).notNullable();
        table.text('worktree_path').notNullable();
        table.text('local_repo_path');
        table.string('base_branch', 255);
        // PR head observed when the attempt began, for diagnostics only.
        table.string('expected_head_sha', 40);
        // Exact Docker label the attempt's agent container carries.
        table.string('container_label', 255);
        // JSON UnprocessedComment[] this attempt claimed and still owes.
        table.text('claimed_comments').notNullable();
        table.string('lock_key', 255).notNullable();
        table.string('lock_token_hash', 255).notNullable();
        table.string('phase', 32).notNullable();
        // Fences recovery: set once by the attempt that adopts this handoff.
        table.string('successor_task_id', 255);
        table.text('next_action');
        table.string('commit_hash', 40);
        table.bigInteger('created_at').notNullable();
        table.bigInteger('updated_at').notNullable();
        table.index(['repository', 'pull_request_number']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('followup_publication_handoffs');
}
