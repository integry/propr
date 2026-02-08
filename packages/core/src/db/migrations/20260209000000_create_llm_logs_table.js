/**
 * Migration to create llm_logs table for tracking all LLM calls.
 * This is separate from llm_executions which is tied to task executions.
 *
 * This table tracks:
 * - Plan generation and refinement
 * - Summarization calls
 * - Context analysis
 * - Any other LLM calls not tied to a specific task
 */
export async function up(knex) {
  await knex.schema.createTable('llm_logs', (table) => {
    table.increments('log_id').primary();
    table.text('execution_type').notNullable(); // plan-generation, plan-refinement, summarization, etc.
    table.text('model_name').nullable();
    table.timestamp('start_time').nullable();
    table.timestamp('end_time').nullable();
    table.integer('duration_ms').nullable();
    table.boolean('success').defaultTo(false);
    table.integer('input_tokens').nullable();
    table.integer('output_tokens').nullable();
    table.integer('cache_creation_input_tokens').nullable();
    table.integer('cache_read_input_tokens').nullable();
    table.decimal('cost_usd', 10, 6).nullable();
    table.text('error_message').nullable();
    table.text('session_id').nullable();
    table.text('correlation_id').nullable();
    table.text('draft_id').nullable(); // For planning-related calls
    table.text('repository').nullable();
    table.text('agent_alias').nullable(); // claude, gemini, codex, etc.
    table.json('metadata').nullable(); // Additional context

    // Indexes for common queries
    table.index('execution_type');
    table.index('start_time');
    table.index('draft_id');
    table.index('model_name');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('llm_logs');
}
