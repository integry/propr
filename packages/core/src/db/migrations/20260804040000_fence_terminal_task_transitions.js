const TERMINAL_INDEX = 'task_history_terminal_task_unique';
const TERMINAL_TRIGGER = 'task_history_terminal_transition_guard';
const TERMINAL_STATES = "'completed', 'failed', 'cancelled'";

/**
 * A task has one terminal result. Keep the first accepted terminal transition
 * and reject every later state change at the durable boundary, including late
 * non-terminal callbacks from another worker process.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('task_history')) return;
  await knex.raw(`
    DELETE FROM task_history AS candidate
    WHERE EXISTS (
      SELECT 1
      FROM task_history AS terminal
      WHERE terminal.task_id = candidate.task_id
        AND lower(terminal.state) IN (${TERMINAL_STATES})
        AND terminal.history_id < candidate.history_id
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${TERMINAL_INDEX}
    ON task_history (task_id)
    WHERE lower(state) IN (${TERMINAL_STATES})
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS ${TERMINAL_TRIGGER}`);
  const hasTransitionKey = await knex.schema.hasColumn('task_history', 'transition_key');
  const retryPredicate = hasTransitionKey
    ? `AND NOT EXISTS (
        SELECT 1 FROM task_history AS retry
        WHERE retry.task_id = NEW.task_id
          AND retry.transition_key = NEW.transition_key
      )`
    : '';
  await knex.raw(`
    CREATE TRIGGER ${TERMINAL_TRIGGER}
    BEFORE INSERT ON task_history
    WHEN EXISTS (
      SELECT 1
      FROM task_history AS terminal
      WHERE terminal.task_id = NEW.task_id
        AND lower(terminal.state) IN (${TERMINAL_STATES})
    )
    ${retryPredicate}
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS ${TERMINAL_TRIGGER}`);
  await knex.raw(`DROP INDEX IF EXISTS ${TERMINAL_INDEX}`);
}
