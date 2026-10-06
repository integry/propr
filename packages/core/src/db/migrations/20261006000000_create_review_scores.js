/**
 * Durable review scores and pull request outcomes for per-model analytics.
 *
 * `review_scores` receives one row every time a `/review` or Ultrafix review
 * cycle produces a parsed `Score: N/10`. `repository_id` is the repository's
 * full name, the key the `repositories` table and every task row already use.
 * The implementer columns are resolved from the task that opened the pull
 * request when the score is written, so a later model relabel cannot rewrite
 * which model the score describes. `goal` is the Ultrafix target in effect for
 * the cycle, and is null for a plain `/review`. `goal_reached` is the cycle's
 * verdict under the rules the Ultrafix loop applies to the whole review job:
 * every reviewer produced a complete, valid, scored review, none reported a
 * blocker, and the authoritative (newest) score met the goal. It is the same on
 * every row of one job, and null for a plain `/review`.
 *
 * `notification_pull_request_state` already tracks one row per pull request
 * (its merge marker), so the final outcome is recorded there: `outcome` is
 * `merged` or `closed`, and `closed_at` is when GitHub reported it. A reopened
 * pull request clears both again.
 */
export async function up(knex) {
  await knex.schema.createTable('review_scores', table => {
    table.increments('id').primary();
    table.string('repository_id', 255).notNullable();
    table.integer('pr_number').notNullable();
    table.string('task_id', 255).notNullable();
    table.string('implementation_task_id', 255);
    table.string('implementer_agent', 100);
    table.string('implementer_model', 100);
    table.string('reviewer_agent', 100);
    table.string('reviewer_model', 100);
    table.integer('score').notNullable();
    table.integer('blocker_count').notNullable().defaultTo(0);
    table.integer('suggestion_count').notNullable().defaultTo(0);
    table.integer('cycle_number');
    table.integer('goal');
    table.boolean('goal_reached');
    table.string('source', 20).notNullable();
    table.string('head_sha', 64);
    table.text('created_at').notNullable();

    table.check('score BETWEEN 1 AND 10', {}, 'review_scores_score_check');
    table.check("source IN ('review', 'ultrafix')", {}, 'review_scores_source_check');
    table.check('blocker_count >= 0 AND suggestion_count >= 0', {}, 'review_scores_count_check');
    table.index(['repository_id', 'pr_number', 'created_at'], 'review_scores_pull_request_index');
    table.index(['implementer_model', 'created_at'], 'review_scores_implementer_index');
    table.index(['created_at'], 'review_scores_created_index');
    table.index(['task_id'], 'review_scores_task_index');
  });

  await knex.raw('ALTER TABLE notification_pull_request_state ADD COLUMN closed_at text NULL');
  await knex.raw("ALTER TABLE notification_pull_request_state ADD COLUMN outcome text NULL CHECK (outcome IS NULL OR outcome IN ('merged', 'closed'))");
}

export async function down(knex) {
  await knex.raw('ALTER TABLE notification_pull_request_state DROP COLUMN outcome');
  await knex.raw('ALTER TABLE notification_pull_request_state DROP COLUMN closed_at');
  await knex.schema.dropTableIfExists('review_scores');
}
