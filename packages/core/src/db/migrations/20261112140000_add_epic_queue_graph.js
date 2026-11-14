// Lets an epic execution be scheduled by its dependency graph. The queue row
// records its execution mode (sequential, parallel or graph) and the most issues
// it may have in flight at once; each issue row records the prerequisites it
// waits for (a JSON array of issue numbers), copied from the plan when the
// execution starts. Existing executions keep null in every new column: their
// mode is still read from `parallel`, and they have no limit or edges beyond
// what their mode implies.
const QUEUE_COLUMNS = [
  ['mode', table => table.string('mode', 16).nullable()],
  ['max_parallel', table => table.integer('max_parallel').nullable()],
];
const ISSUE_COLUMNS = [
  ['depends_on', table => table.text('depends_on').nullable()],
];

async function addColumns(knex, tableName, columns) {
  if (!(await knex.schema.hasTable(tableName))) return;
  for (const [column, define] of columns) {
    if (await knex.schema.hasColumn(tableName, column)) continue;
    await knex.schema.alterTable(tableName, define);
  }
}

async function dropColumns(knex, tableName, columns) {
  if (!(await knex.schema.hasTable(tableName))) return;
  for (const [column] of [...columns].reverse()) {
    if (!(await knex.schema.hasColumn(tableName, column))) continue;
    await knex.schema.alterTable(tableName, table => table.dropColumn(column));
  }
}

export async function up(knex) {
  await addColumns(knex, 'epic_execution_queues', QUEUE_COLUMNS);
  await addColumns(knex, 'epic_execution_queue_issues', ISSUE_COLUMNS);
}

export async function down(knex) {
  await dropColumns(knex, 'epic_execution_queue_issues', ISSUE_COLUMNS);
  await dropColumns(knex, 'epic_execution_queues', QUEUE_COLUMNS);
}
