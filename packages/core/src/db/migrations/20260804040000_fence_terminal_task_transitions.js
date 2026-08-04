const TERMINAL_INDEX = 'task_history_terminal_task_unique';
const TERMINAL_TRIGGER = 'task_history_terminal_transition_guard';
const CLEANUP_AUDIT_TABLE = 'task_terminal_transition_cleanup_audit';
const TERMINAL_STATES = "'completed', 'failed', 'cancelled'";
const CLEANUP_BATCH_SIZE = 200;

// Each cleanup batch is restart-safe. Avoid wrapping the installation-wide scan
// in one SQLite write transaction so deployments release the writer lock between
// bounded archive/delete statements.
export const config = { transaction: false };

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
  const hasEnrichments = await knex.schema.hasTable('task_notification_enrichments');
  while (true) {
    // A bounded anti-corruption scan avoids loading an installation's complete
    // task history or exceeding SQLite's host-parameter limit during cleanup.
    const cleanupRows = await knex('task_history as candidate')
      .select('candidate.*')
      .whereRaw(`EXISTS (
        SELECT 1 FROM task_history AS terminal
        WHERE terminal.task_id = candidate.task_id
          AND terminal.history_id < candidate.history_id
          AND lower(terminal.state) IN (${TERMINAL_STATES})
      )`)
      .orderBy('candidate.history_id', 'asc')
      .limit(CLEANUP_BATCH_SIZE);
    if (cleanupRows.length === 0) return;

    const historyIds = cleanupRows.map((row) => row.history_id);
    const cleanedAt = new Date().toISOString();
    await knex(CLEANUP_AUDIT_TABLE).insert(cleanupRows.map((row) => ({
      record_type: 'task_history',
      record_id: String(row.history_id),
      task_id: row.task_id,
      history_id: row.history_id,
      payload_json: JSON.stringify(row),
      cleaned_at: cleanedAt,
    }))).onConflict(['record_type', 'record_id']).ignore();

    if (hasEnrichments) {
      let lastChangeId = 0;
      while (true) {
        const enrichmentRows = await knex('task_notification_enrichments')
          .whereIn('transition_history_id', historyIds)
          .andWhere('change_id', '>', lastChangeId)
          .orderBy('change_id', 'asc')
          .limit(CLEANUP_BATCH_SIZE);
        if (enrichmentRows.length === 0) break;
        await knex(CLEANUP_AUDIT_TABLE).insert(enrichmentRows.map((row) => ({
          record_type: 'task_notification_enrichment',
          record_id: String(row.change_id),
          task_id: row.task_id,
          history_id: row.transition_history_id,
          payload_json: JSON.stringify(row),
          cleaned_at: cleanedAt,
        }))).onConflict(['record_type', 'record_id']).ignore();
        lastChangeId = enrichmentRows.at(-1).change_id;
      }
    }

    // TaskState treats completed/failed/cancelled as final outcomes; queue retries
    // occur before a terminal row is accepted. Preserve every conflicting legacy
    // row in the audit table before removing it from the authoritative timeline.
    await knex('task_history').whereIn('history_id', historyIds).delete();
  }
}

async function installTerminalGuard(knex) {
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

/**
 * A task has one terminal result. Keep the first accepted terminal transition
 * and reject every later state change at the durable boundary, including late
 * non-terminal callbacks from another worker process.
 */
export async function up(knex) {
  if (!await knex.schema.hasTable('task_history')) return;
  await ensureCleanupAuditTable(knex);
  // Fence new post-terminal writes before releasing the writer lock between
  // cleanup batches.
  await installTerminalGuard(knex);
  await archivePostTerminalRows(knex);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${TERMINAL_INDEX}
    ON task_history (task_id)
    WHERE lower(state) IN (${TERMINAL_STATES})
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS ${TERMINAL_TRIGGER}`);
  await knex.raw(`DROP INDEX IF EXISTS ${TERMINAL_INDEX}`);
  // Cleanup evidence is retained because deleted duplicate terminal rows cannot
  // be safely reinserted while newer task history may now exist.
}
