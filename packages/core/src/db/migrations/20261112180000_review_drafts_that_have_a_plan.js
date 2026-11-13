// Drafts created through MCP `create_plan` with plan items were stored as
// 'draft', which Studio shows as a prompt with no plan. A draft that already
// holds plan items is reviewable, so move those rows to 'review'. Prompt-only
// drafts and every other status are left alone.
export async function up(knex) {
  if (!(await knex.schema.hasTable('task_drafts'))) return;
  await knex('task_drafts')
    .where({ status: 'draft' })
    .whereNotNull('plan_json')
    .whereRaw('json_valid(plan_json)')
    .whereRaw("json_type(plan_json) = 'array'")
    .whereRaw('json_array_length(plan_json) > 0')
    .update({ status: 'review' });
}

// Not reversible: which rows were moved is not recorded, and 'review' is the
// correct status for them on any version.
export async function down() {}
