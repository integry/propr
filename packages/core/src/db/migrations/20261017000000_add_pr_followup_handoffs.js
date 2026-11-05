// Durable handoff for a PR follow-up whose publication a worker restart can
// interrupt after the agent produced work but before commit/push/comment
// publication. The row is written before the agent launches and outlives the
// worker process, so restart recovery can adopt the retained worktree and
// finish the exact missing phase instead of stranding the branch.
export async function up(knex) {
    await knex.schema.createTable('pr_followup_handoffs', table => {
        table.string('repository', 255).notNullable();
        table.integer('pull_request').notNullable();
        table.string('task_id', 255).notNullable();
        // Prior attempt task IDs this handoff descends from, as a JSON array.
        table.text('source_task_ids').notNullable().defaultTo('[]');
        table.string('correlation_id', 255);
        // Where the work publishes: may differ from `repository` for continuations.
        table.string('target_repository', 255).notNullable();
        table.string('branch_name', 255).notNullable();
        table.integer('is_fork').notNullable().defaultTo(0);
        table.text('worktree_path').notNullable();
        table.text('local_repo_path').notNullable();
        table.text('claimed_comments').notNullable().defaultTo('[]');
        table.text('job_data').notNullable().defaultTo('{}');
        table.string('llm', 255);
        // agent_running | agent_exited | committed | pushed | comment_published | cleanup_pending
        table.string('phase', 32).notNullable().defaultTo('agent_running');
        // 1 when the agent exited reporting full success, 0 when it stopped
        // short, null until it exits. Only a recorded full success lets a
        // recovered completion comment bind the accepted request bodies.
        table.integer('agent_completed');
        // The cleaned analysis a fully successful agent reported, persisted with
        // agent_completed so recovery of a no-change success can deliver the
        // completion answer the interrupted normal path owed.
        table.text('agent_summary');
        // active | awaiting_operator | released
        table.string('status', 32).notNullable().defaultTo('active');
        table.string('status_reason', 255);
        // Durable classification of who owns the claimed comments once the
        // attempt settles without publishing (returned to the queue, or held
        // by a scheduled usage-limit retry). Unlike status_reason, diagnostics
        // never overwrite it, so retirement reports the semantic outcome.
        table.string('settlement', 64);
        // Explicit operator authorization to publish after a user cancellation.
        table.integer('operator_authorized').notNullable().defaultTo(0);
        table.bigInteger('starting_comment_id');
        table.string('commit_hash', 64);
        table.text('completion_comment_url');
        // Publication binding captured before the agent launches: the pull
        // request's head/base refs and the worktree HEAD the agent builds on.
        // Recovery revalidates them before pushing and fails closed on mismatch.
        table.string('head_ref', 255);
        table.string('base_ref', 255);
        table.string('head_sha', 64);
        // Immutable agent container identity, bound as soon as the container
        // starts; recovery refuses to act on a different container's evidence.
        table.string('container_id', 255);
        // Task that adopted this handoff's obligation, for operator status.
        table.string('successor_task_id', 255);
        // PR processing lease ownership recorded at handoff time.
        table.string('lock_key', 512).notNullable();
        table.string('lock_token', 512).notNullable();
        // Optimistic-concurrency token: every write bumps it, so a stale pass
        // matches nothing and a newer owner's state survives duplicate recovery.
        table.integer('generation').notNullable().defaultTo(0);
        // Unique across deletion/recreation of the same (repository, pull_request).
        table.string('incarnation', 64).notNullable();
        // Epoch milliseconds.
        table.bigInteger('created_at').notNullable();
        table.bigInteger('updated_at').notNullable();
        table.primary(['repository', 'pull_request']);
        table.index(['task_id']);
        table.index(['status']);
    });
    // Comment IDs claimed by a cancelled, never-authorized follow-up whose
    // handoff an operator released. The handoff row is replaceable by a later
    // task and deleted on retirement, so this suppression evidence lives apart
    // from it: a follow-up that captured these comments before taking the PR
    // lease drops them under the lease, however many handoffs ran meanwhile.
    await knex.schema.createTable('pr_followup_cancelled_claims', table => {
        table.string('repository', 255).notNullable();
        table.integer('pull_request').notNullable();
        table.bigInteger('comment_id').notNullable();
        table.string('task_id', 255).notNullable();
        // Epoch milliseconds.
        table.bigInteger('created_at').notNullable();
        table.primary(['repository', 'pull_request', 'comment_id']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('pr_followup_cancelled_claims');
    await knex.schema.dropTableIfExists('pr_followup_handoffs');
}
