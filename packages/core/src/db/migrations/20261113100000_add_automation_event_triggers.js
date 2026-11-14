/**
 * Event triggers for automations.
 *
 * - `agent_definitions.event_triggers`: the definition's event subscriptions (JSON text,
 *   `[]` by default, so no existing definition subscribes to anything).
 * - `agent_definition_event_cursors`: per definition and event, the id of the last durable
 *   event the worker has handled. A cursor is set to the newest event when a definition
 *   subscribes or is enabled again, so events from before (or from while it was disabled)
 *   are never run later.
 * - `agent_runs.trigger_event`: the event an `event` run was started by (JSON text), and
 *   `trigger_subject`, the issue it concerns, which bounds the runs per issue.
 */
const DEFINITIONS = 'agent_definitions';
const RUNS = 'agent_runs';
const CURSORS = 'agent_definition_event_cursors';

export async function up(knex) {
  if (!(await knex.schema.hasColumn(DEFINITIONS, 'event_triggers'))) {
    await knex.schema.alterTable(DEFINITIONS, table => table.text('event_triggers').notNullable().defaultTo('[]'));
  }
  if (!(await knex.schema.hasColumn(RUNS, 'trigger_event'))) {
    await knex.schema.alterTable(RUNS, table => {
      table.text('trigger_event').nullable();
      table.string('trigger_subject').nullable();
      table.index(['definition_id', 'trigger_subject']);
    });
  }
  if (!(await knex.schema.hasTable(CURSORS))) {
    await knex.schema.createTable(CURSORS, table => {
      table.uuid('definition_id').notNullable().references('id').inTable(DEFINITIONS).onDelete('CASCADE');
      table.string('event', 64).notNullable();
      table.bigInteger('cursor').notNullable().defaultTo(0);
      table.bigInteger('updated_at').notNullable();
      table.primary(['definition_id', 'event']);
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(CURSORS);
  if (await knex.schema.hasColumn(RUNS, 'trigger_event')) {
    await knex.schema.alterTable(RUNS, table => {
      table.dropIndex(['definition_id', 'trigger_subject']);
      table.dropColumn('trigger_subject');
      table.dropColumn('trigger_event');
    });
  }
  if (await knex.schema.hasColumn(DEFINITIONS, 'event_triggers')) {
    await knex.schema.alterTable(DEFINITIONS, table => table.dropColumn('event_triggers'));
  }
}
