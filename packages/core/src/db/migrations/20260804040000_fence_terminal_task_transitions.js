const TERMINAL_INDEX = 'task_history_terminal_task_unique';
const TERMINAL_TRIGGER = 'task_history_terminal_transition_guard';
const CLEANUP_AUDIT_TABLE = 'task_terminal_transition_cleanup_audit';
const TERMINAL_STATES = "'completed', 'failed', 'cancelled'";
const TERMINAL_STATE_VALUES = new Set(['completed', 'failed', 'cancelled']);

async function ensureCleanupAuditTable(knex) {
  if (await knex.schema.hasTable(CLEANUP_AUDIT_TABLE)) return;
  await knex.schema.createTable(CLEANUP_AUDIT_TABLE, (table) => {
    table.text('record_type').notNullable();
    table.text('record_id').notNullable();
    table.text('task_id').notNullable();
    table.integer('history_id').notNullable();
    table.text('payload_json').notNullable();
    table.text('cleaned_at').notNullable();
    table.primary(['record_type', 'record_id']);
    table.index('task_id', 'task_terminal_transition_cleanup_audit_task_idx');
  });
}

async function archivePostTerminalRows(knex) {
  const historyRows = await knex('task_history')
    .orderBy(['task_id', 'history_id']);
  const firstTerminalByTask = new Map();
  const cleanupRows = [];
  for (const row of historyRows) {
    const firstTerminalId = firstTerminalByTask.get(row.task_id);
    if (firstTerminalId !== undefined) {
      if (row.history_id <= firstTerminalId) {
        throw new Error('Unexpected task history ordering during terminal cleanup');
      }
      cleanupRows.push(row);
    } else if (TERMINAL_STATE_VALUES.has(String(row.state).toLowerCase())) {
      firstTerminalByTask.set(row.task_id, row.history_id);
    }
  }
  if (cleanupRows.length === 0) return;

  const historyIds = cleanupRows.map((row) => row.history_id);
  const enrichmentRows = await knex.schema.hasTable('task_notification_enrichments')
    ? await knex('task_notification_enrichments')
      .whereIn('transition_history_id', historyIds)
      .orderBy('change_id')
    : [];
  const cleanedAt = new Date().toISOString();
  const auditRows = [
    ...cleanupRows.map((row) => ({
      record_type: 'task_history',
      record_id: String(row.history_id),
      task_id: row.task_id,
      history_id: row.history_id,
      payload_json: JSON.stringify(row),
      cleaned_at: cleanedAt,
    })),
    ...enrichmentRows.map((row) => ({
      record_type: 'task_notification_enrichment',
      record_id: String(row.change_id),
      task_id: row.task_id,
      history_id: row.transition_history_id,
      payload_json: JSON.stringify(row),
      cleaned_at: cleanedAt,
    })),
  ];
  await knex(CLEANUP_AUDIT_TABLE).insert(auditRows)
    .onConflict(['record_type', 'record_id']).ignore();
  // This is intentionally irreversible: only rows proven to follow the first
  // terminal outcome are removed, after those rows and cascade-linked evidence have
  // been copied into the durable audit table above.
  await knex('task_history').whereIn('history_id', historyIds).delete();
}

/**
 * A task has one terminal result. Keep the first accepted terminal transition
 * and reject every later state change at the durable boundary, including late
 * non-terminal callbacks from another worker process.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('task_history')) return;
  await ensureCleanupAuditTable(knex);
  await archivePostTerminalRows(knex);
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
  // Cleanup evidence is retained because deleted duplicate terminal rows cannot
  // be safely reinserted while newer task history may now exist.
}
