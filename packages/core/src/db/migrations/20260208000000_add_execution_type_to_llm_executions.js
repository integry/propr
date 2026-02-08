/**
 * Migration to add execution_type column to llm_executions table.
 * This tracks the type of LLM execution for visibility into AI usage and costs.
 *
 * Standard execution types:
 * - implementation: Code generation and modification (default)
 * - plan-generation: Initial plan creation from user prompt
 * - plan-refinement: Modifying the plan based on user feedback
 * - title-generation: Generating concise titles/summaries for tasks or followups
 * - summarization: Repository indexing and file summarization
 * - context-analysis: Analyzing relevance of files to a prompt
 * - task-analysis: Post-execution analysis of changes
 * - lightweight-analysis: Generic lightweight calls if not otherwise specified
 */
export async function up(knex) {
  await knex.schema.alterTable('llm_executions', (table) => {
    table.text('execution_type').nullable().defaultTo('implementation');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('llm_executions', (table) => {
    table.dropColumn('execution_type');
  });
}
