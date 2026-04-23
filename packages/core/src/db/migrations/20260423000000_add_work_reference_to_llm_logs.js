/**
 * Migration to add normalized work-reference columns to llm_logs table.
 *
 * These columns answer "what piece of work did this LLM call belong to?"
 * without requiring callers to dig through metadata or infer from draft_id.
 *
 * - work_type: discriminator for the kind of work (task, plan, repository)
 * - task_id: links to a specific task execution
 * - task_number: the GitHub issue number for the task
 * - plan_draft_id: links to the plan/draft that triggered this call
 * - plan_issue_id: links to a specific plan issue within a draft
 * - work_repository: owner/repo for the work context (may differ from existing `repository`)
 *
 * All columns are nullable so existing flows adopt them incrementally.
 */
export async function up(knex) {
  await knex.schema.alterTable('llm_logs', (table) => {
    table.text('work_type').nullable();
    table.text('task_id').nullable();
    table.integer('task_number').nullable();
    table.integer('pr_number').nullable();
    table.text('plan_draft_id').nullable();
    table.integer('plan_issue_id').nullable();
    table.text('work_repository').nullable();

    // Indexes for the main lookup paths
    table.index('work_type', 'idx_llm_logs_work_type');
    table.index('task_id', 'idx_llm_logs_task_id');
    table.index('task_number', 'idx_llm_logs_task_number');
    table.index('pr_number', 'idx_llm_logs_pr_number');
    table.index('plan_draft_id', 'idx_llm_logs_plan_draft_id');
    table.index('plan_issue_id', 'idx_llm_logs_plan_issue_id');
    table.index('work_repository', 'idx_llm_logs_work_repository');
  });

  // Add CHECK constraint for valid work_type values
  await knex.raw(`
    ALTER TABLE llm_logs
    ADD CONSTRAINT chk_llm_logs_work_type
    CHECK (work_type IS NULL OR work_type IN ('task', 'plan', 'repository'))
  `);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE llm_logs DROP CONSTRAINT IF EXISTS chk_llm_logs_work_type');

  await knex.schema.alterTable('llm_logs', (table) => {
    table.dropIndex('work_type', 'idx_llm_logs_work_type');
    table.dropIndex('task_id', 'idx_llm_logs_task_id');
    table.dropIndex('task_number', 'idx_llm_logs_task_number');
    table.dropIndex('pr_number', 'idx_llm_logs_pr_number');
    table.dropIndex('plan_draft_id', 'idx_llm_logs_plan_draft_id');
    table.dropIndex('plan_issue_id', 'idx_llm_logs_plan_issue_id');
    table.dropIndex('work_repository', 'idx_llm_logs_work_repository');

    table.dropColumn('work_type');
    table.dropColumn('task_id');
    table.dropColumn('task_number');
    table.dropColumn('pr_number');
    table.dropColumn('plan_draft_id');
    table.dropColumn('plan_issue_id');
    table.dropColumn('work_repository');
  });
}
