const HISTORY_TRANSITION_INDEX = 'task_history_transition_key_unique';
const ENRICHMENT_CHANGE_INDEX = 'task_notification_enrichments_change_key_unique';

/**
 * Give every worker-state transition and post-transition enrichment a stable
 * retry identity. The nullable columns keep rolling upgrades compatible; all
 * existing rows are assigned a unique legacy identity before the indexes land.
 */
export async function up(knex) {
  if (await knex.schema.hasTable('task_history')
      && !await knex.schema.hasColumn('task_history', 'transition_key')) {
    await knex.schema.alterTable('task_history', (table) => {
      table.text('transition_key').nullable();
    });
    await knex.raw(`
      UPDATE task_history
      SET transition_key = CASE
        WHEN history_id = (
          SELECT MIN(first_history.history_id)
          FROM task_history AS first_history
          WHERE first_history.task_id = task_history.task_id
        ) AND state = 'pending'
          THEN 'task-created:' || task_id
        ELSE 'legacy-history:' || history_id
      END
      WHERE transition_key IS NULL
    `);
    await knex.schema.alterTable('task_history', (table) => {
      table.unique(['task_id', 'transition_key'], HISTORY_TRANSITION_INDEX);
    });
  }

  if (await knex.schema.hasTable('task_notification_enrichments')
      && !await knex.schema.hasColumn('task_notification_enrichments', 'change_key')) {
    await knex.schema.alterTable('task_notification_enrichments', (table) => {
      table.text('change_key').nullable();
    });
    await knex.raw(`
      UPDATE task_notification_enrichments
      SET change_key = 'legacy-enrichment:' || change_id
      WHERE change_key IS NULL
    `);
    await knex.schema.alterTable('task_notification_enrichments', (table) => {
      table.unique(['task_id', 'change_key'], ENRICHMENT_CHANGE_INDEX);
    });
  }
}

export async function down(knex) {
  if (await knex.schema.hasTable('task_notification_enrichments')
      && await knex.schema.hasColumn('task_notification_enrichments', 'change_key')) {
    await knex.schema.alterTable('task_notification_enrichments', (table) => {
      table.dropUnique(['task_id', 'change_key'], ENRICHMENT_CHANGE_INDEX);
      table.dropColumn('change_key');
    });
  }
  if (await knex.schema.hasTable('task_history')
      && await knex.schema.hasColumn('task_history', 'transition_key')) {
    await knex.schema.alterTable('task_history', (table) => {
      table.dropUnique(['task_id', 'transition_key'], HISTORY_TRANSITION_INDEX);
      table.dropColumn('transition_key');
    });
  }
}
