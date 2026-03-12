/**
 * Migration to create repo_chat_messages table for persisting repository chat messages.
 *
 * This table stores chat conversations per repository, allowing users to:
 * - View chat history when returning to a repository
 * - Clear all messages for a repository
 * - Delete individual messages
 */
export async function up(knex) {
  await knex.schema.createTable('repo_chat_messages', (table) => {
    table.increments('id').primary();
    table.text('message_id').notNullable().unique(); // Client-generated UUID
    table.text('repository').notNullable(); // owner/repo format
    table.text('role').notNullable(); // 'user' or 'assistant'
    table.text('content').notNullable();
    table.timestamp('timestamp').notNullable();
    table.integer('estimated_duration_ms').nullable();
    table.integer('actual_duration_ms').nullable();
    table.boolean('is_historical_estimate').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    // Indexes for common queries
    table.index('repository');
    table.index(['repository', 'timestamp']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('repo_chat_messages');
}
