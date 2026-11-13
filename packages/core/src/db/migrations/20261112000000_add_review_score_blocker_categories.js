// Per-review blocker counts by category, as a JSON object keyed by the closed
// category vocabulary, e.g. {"correctness":1,"style":2,...}. Rows written
// before categories existed stay null: their blockers were never categorised.
const TABLE = 'review_scores';
const COLUMN = 'blocker_categories';

export async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, table => {
    table.text(COLUMN).nullable();
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || !(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, table => {
    table.dropColumn(COLUMN);
  });
}
