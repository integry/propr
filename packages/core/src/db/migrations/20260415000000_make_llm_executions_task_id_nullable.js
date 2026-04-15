/**
 * Migration to make task_id nullable in llm_executions table.
 * This allows logging LLM calls for drafts/plan generation where task doesn't exist yet.
 *
 * SQLite doesn't support ALTER COLUMN, so we recreate the table.
 */

export async function up(knex) {
  // Check if we're using SQLite
  const isSqlite = knex.client.config.client === 'better-sqlite3' || knex.client.config.client === 'sqlite3';

  if (isSqlite) {
    // SQLite: Need to recreate table to change column nullability
    // First, drop the foreign key by recreating without it
    await knex.schema.raw(`
      CREATE TABLE llm_executions_new (
        execution_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id VARCHAR(255),
        history_id INTEGER,
        session_id VARCHAR(255),
        conversation_id VARCHAR(255),
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP,
        duration_ms INTEGER,
        model_name VARCHAR(100) NOT NULL,
        success BOOLEAN NOT NULL,
        num_turns INTEGER,
        cost_usd DECIMAL(10, 6),
        error_message TEXT,
        prompt_length INTEGER,
        output_length INTEGER,
        analysis_report JSON,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (history_id) REFERENCES task_history(history_id) ON DELETE SET NULL
      )
    `);

    // Copy data - explicitly list all columns to avoid order issues
    await knex.schema.raw(`
      INSERT INTO llm_executions_new (
        execution_id, task_id, history_id, session_id, conversation_id,
        start_time, end_time, duration_ms, model_name, success,
        num_turns, cost_usd, error_message, prompt_length, output_length,
        analysis_report, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens
      )
      SELECT
        execution_id, task_id, history_id, session_id, conversation_id,
        start_time, end_time, duration_ms, model_name, success,
        num_turns, cost_usd, error_message, prompt_length, output_length,
        analysis_report, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens
      FROM llm_executions
    `);

    // Drop old table
    await knex.schema.raw('DROP TABLE llm_executions');

    // Rename new table
    await knex.schema.raw('ALTER TABLE llm_executions_new RENAME TO llm_executions');

    // Recreate indexes
    await knex.schema.raw('CREATE INDEX llm_executions_task_id_index ON llm_executions(task_id)');
    await knex.schema.raw('CREATE INDEX llm_executions_model_name_index ON llm_executions(model_name)');
    await knex.schema.raw('CREATE INDEX llm_executions_start_time_index ON llm_executions(start_time)');
  } else {
    // PostgreSQL/MySQL: Can alter column directly
    await knex.schema.alterTable('llm_executions', (table) => {
      table.string('task_id', 255).nullable().alter();
    });
  }
}

export async function down(knex) {
  const isSqlite = knex.client.config.client === 'better-sqlite3' || knex.client.config.client === 'sqlite3';

  if (isSqlite) {
    // For rollback, we'd need to ensure no NULL task_ids exist first
    // Then recreate with NOT NULL constraint
    // This is a lossy operation if NULLs exist
    console.warn('Rollback may fail if NULL task_ids exist in llm_executions');
  } else {
    await knex.schema.alterTable('llm_executions', (table) => {
      table.string('task_id', 255).notNullable().alter();
    });
  }
}
