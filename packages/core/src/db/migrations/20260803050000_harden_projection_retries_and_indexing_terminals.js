const RETRY_TABLE = 'notification_projection_retries';
const TERMINAL_INDEX = 'repository_indexing_transitions_terminal_run_unique';

async function createProjectionRetries(knex) {
  if (await knex.schema.hasTable(RETRY_TABLE)) return;
  await knex.schema.createTable(RETRY_TABLE, (table) => {
    table.text('source').notNullable();
    table.text('transition_key').notNullable();
    table.text('payload_json').notNullable();
    table.integer('attempt_count').notNullable().defaultTo(0);
    table.text('created_at').notNullable();
    table.text('updated_at').notNullable();
    table.primary(['source', 'transition_key']);
    table.index(
      ['attempt_count', 'updated_at', 'source', 'transition_key'],
      'notification_projection_retries_scan_idx'
    );
    table.check(
      "source IN ('terminal-task-history', 'task-notification-enrichments', "
        + "'terminal-indexing-history', 'terminal-indexing-current', 'review-drafts')",
      {},
      'notification_projection_retries_source_check'
    );
    table.check(
      'attempt_count >= 0',
      {},
      'notification_projection_retries_attempt_count_check'
    );
    table.check(
      'json_valid(payload_json)',
      {},
      'notification_projection_retries_payload_check'
    );
  });
}

async function enforceOneTerminalResult(knex) {
  if (!await knex.schema.hasTable('repository_indexing_transitions')) return;
  // Preserve the first accepted terminal result before adding the invariant to
  // databases that briefly ran an older rolling-upgrade implementation.
  if (await knex.schema.hasColumn('repositories', 'indexing_run_id')
      && await knex.schema.hasColumn('repositories', 'indexing_transition_at')) {
    await knex.raw(`
      UPDATE repositories AS repository
      SET indexing_status = (
            SELECT transition.status
            FROM repository_indexing_transitions AS transition
            WHERE transition.full_name = repository.full_name
              AND transition.branch = repository.branch
              AND transition.run_id = repository.indexing_run_id
              AND transition.status IN ('idle', 'completed', 'failed')
            ORDER BY transition.transition_id ASC
            LIMIT 1
          ),
          indexing_transition_at = (
            SELECT transition.transition_at
            FROM repository_indexing_transitions AS transition
            WHERE transition.full_name = repository.full_name
              AND transition.branch = repository.branch
              AND transition.run_id = repository.indexing_run_id
              AND transition.status IN ('idle', 'completed', 'failed')
            ORDER BY transition.transition_id ASC
            LIMIT 1
          ),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE EXISTS (
        SELECT 1
        FROM repository_indexing_transitions AS transition
        WHERE transition.full_name = repository.full_name
          AND transition.branch = repository.branch
          AND transition.run_id = repository.indexing_run_id
          AND transition.status IN ('idle', 'completed', 'failed')
      )
    `);
  }
  await knex.raw(`
    DELETE FROM repository_indexing_transitions
    WHERE status IN ('idle', 'completed', 'failed')
      AND transition_id NOT IN (
        SELECT MIN(transition_id)
        FROM repository_indexing_transitions
        WHERE status IN ('idle', 'completed', 'failed')
        GROUP BY full_name, branch, run_id
      )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${TERMINAL_INDEX}
    ON repository_indexing_transitions (full_name, branch, run_id)
    WHERE status IN ('idle', 'completed', 'failed')
  `);
}

export async function up(knex) {
  await createProjectionRetries(knex);
  await enforceOneTerminalResult(knex);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${TERMINAL_INDEX}`);
  await knex.schema.dropTableIfExists(RETRY_TABLE);
}
