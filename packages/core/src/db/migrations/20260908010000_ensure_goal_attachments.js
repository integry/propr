/** Repair databases that reached the goal attachment rollout without its column. */
export async function up(knex) {
  if (await knex.schema.hasColumn('goals', 'attachments')) return;

  await knex.schema.alterTable('goals', table => {
    table.json('attachments').notNullable().defaultTo('[]');
  });
}

/**
 * The preceding attachment migration owns this column. Rolling back this
 * reconciliation must not remove schema that may predate the repair.
 */
export function down() {}
