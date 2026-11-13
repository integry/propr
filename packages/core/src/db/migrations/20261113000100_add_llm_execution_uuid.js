// The execution id an agent result carries, stored on its `llm_executions` row
// under a unique index. Redis claims and a bounded in-process set keep a second
// record of the same result from inserting a second row while they last; the
// index keeps it from doing so after they expire or are lost. Rows recorded
// before this column, and results that carry no id, hold null, which the index
// does not constrain.
const TABLE = 'llm_executions';
const COLUMN = 'execution_uuid';
const INDEX = 'llm_executions_execution_uuid_unique';

export async function up(knex) {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, table => {
    table.string(COLUMN, 64).nullable();
    table.unique([COLUMN], { indexName: INDEX });
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, table => {
    table.dropUnique([COLUMN], INDEX);
    table.dropColumn(COLUMN);
  });
}
