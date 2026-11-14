// Records which plan item each published issue came from, and the issue
// numbers of the items it depends on (a JSON array). Rows published before
// this migration keep null in both columns, which reads as "no prerequisites".
// Columns are added in place: rebuilding the table would drop its triggers.
const COLUMNS = [
  ['plan_item_id', table => table.string('plan_item_id', 255).nullable()],
  ['depends_on_issues', table => table.text('depends_on_issues').nullable()],
];

export async function up(knex) {
  if (!(await knex.schema.hasTable('plan_issues'))) return;
  for (const [column, define] of COLUMNS) {
    if (await knex.schema.hasColumn('plan_issues', column)) continue;
    await knex.schema.alterTable('plan_issues', define);
  }
}

export async function down(knex) {
  if (!(await knex.schema.hasTable('plan_issues'))) return;
  for (const [column] of [...COLUMNS].reverse()) {
    if (!(await knex.schema.hasColumn('plan_issues', column))) continue;
    await knex.schema.alterTable('plan_issues', table => table.dropColumn(column));
  }
}
