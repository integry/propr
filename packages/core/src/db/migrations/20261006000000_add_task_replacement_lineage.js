/**
 * Lineage for automatic replacement runs (infrastructure-lost and transient
 * provider failures).
 *
 * - `replaces_task_id` / `replaced_by_task_id` link one attempt to the next;
 *   `replaced_by_task_id` doubles as the atomic claim that guarantees exactly
 *   one replacement per attempt.
 * - `attempt_number` (NULL reads as 1) and `lineage_root_task_id` let the cap
 *   be counted from durable stamps, so it survives daemon/worker restarts.
 * - `replacement_cause` records why this attempt was created
 *   (`infra_lost` or `provider_transient`).
 * - `replacement_state` / `replacement_request` track a replacement decision
 *   for this task (`pending`, `dispatched`, `skipped`, `exhausted`), so a
 *   decision interrupted by a restart is completed by the reconciler and the
 *   Inbox can suppress a failure alert that a replacement supersedes.
 * - `replay_job_data` keeps the queue payload (agent/model selection and
 *   per-task overrides, without bulky GitHub payloads) needed to re-run it.
 * - `branch_name` is the work branch once it has been pushed.
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.string('replaces_task_id', 255).nullable();
    table.string('replaced_by_task_id', 255).nullable();
    table.integer('attempt_number').nullable();
    table.string('lineage_root_task_id', 255).nullable();
    table.string('replacement_cause', 32).nullable();
    table.string('replacement_state', 32).nullable();
    table.json('replacement_request').nullable();
    table.json('replay_job_data').nullable();
    table.string('branch_name', 255).nullable();

    table.index('replaces_task_id');
    table.index('lineage_root_task_id');
    table.index('replacement_state');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.dropIndex('replaces_task_id');
    table.dropIndex('lineage_root_task_id');
    table.dropIndex('replacement_state');
    table.dropColumn('replaces_task_id');
    table.dropColumn('replaced_by_task_id');
    table.dropColumn('attempt_number');
    table.dropColumn('lineage_root_task_id');
    table.dropColumn('replacement_cause');
    table.dropColumn('replacement_state');
    table.dropColumn('replacement_request');
    table.dropColumn('replay_job_data');
    table.dropColumn('branch_name');
  });
}
