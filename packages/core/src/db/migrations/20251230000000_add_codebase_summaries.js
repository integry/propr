/**
 * Add codebase summaries schema for Semantic Code Search feature
 *
 * This migration adds:
 * 1. file_summaries - Stores AI-generated summaries for individual files
 * 2. directory_summaries - Stores aggregated summaries for directories
 * 3. repositories table with indexing_status and last_indexed_at columns
 *
 * Configuration keys (stored in system_configs key-value store):
 * - 'summarization.enabled' (boolean) - Enable/disable summarization
 * - 'summarization.agent_alias' (string) - Which agent from the registry to use
 */
export async function up(knex) {
  // 1. File Summaries - stores summary for a specific file version
  await knex.schema.createTable('file_summaries', (table) => {
    table.string('path').primary(); // Primary Key implies Index
    table.text('summary').notNullable();
    table.string('commit_hash').notNullable(); // Full SHA-1 hash of file content
    table.string('model_used').nullable(); // Agent alias used (e.g., 'gemini-1.5-flash')
    table.timestamp('last_updated_at').defaultTo(knex.fn.now());
  });

  // 2. Directory Summaries - stores aggregated summary for a directory
  await knex.schema.createTable('directory_summaries', (table) => {
    table.string('path').primary();
    table.text('summary').notNullable();
    table.string('hash').notNullable(); // Composite hash of children state
    table.timestamp('last_updated_at').defaultTo(knex.fn.now());
  });

  // 3. Repositories table - track indexing status per repository
  // Note: Creating new table since repositories were previously denormalized
  await knex.schema.createTable('repositories', (table) => {
    table.string('full_name').primary(); // e.g., 'owner/repo'
    table.string('indexing_status').defaultTo('idle'); // 'idle', 'indexing', 'completed', 'failed'
    table.timestamp('last_indexed_at').nullable(); // Completion time of last successful full scan
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.index('indexing_status');
  });
}

export async function down(knex) {
  // Drop in reverse order of creation
  await knex.schema.dropTableIfExists('repositories');
  await knex.schema.dropTableIfExists('directory_summaries');
  await knex.schema.dropTableIfExists('file_summaries');
}
