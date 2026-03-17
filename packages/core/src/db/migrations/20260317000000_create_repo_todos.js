/**
 * Migration to create repo_todo_categories and repo_todos tables.
 *
 * These tables support the repository to-do feature, allowing users to record
 * quick ideas, notes, or future tasks that can be organized into categories
 * and eventually converted into full execution plans.
 */
export async function up(knex) {
  // Create categories table first (referenced by todos)
  await knex.schema.createTable('repo_todo_categories', (table) => {
    table.increments('id').primary();
    table.text('category_id').notNullable().unique(); // UUID for client reference
    table.text('user_id').notNullable(); // Owner of the category
    table.text('repository').notNullable(); // owner/repo format
    table.text('name').notNullable();
    table.integer('order_index').notNullable().defaultTo(0); // For drag-and-drop ordering
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    // Indexes for common queries
    table.index('user_id');
    table.index('repository');
    table.index(['user_id', 'repository']);
    table.index(['user_id', 'repository', 'order_index']);
  });

  // Create todos table
  await knex.schema.createTable('repo_todos', (table) => {
    table.increments('id').primary();
    table.text('todo_id').notNullable().unique(); // UUID for client reference
    table.text('user_id').notNullable(); // Owner of the todo
    table.text('repository').notNullable(); // owner/repo format
    table.text('category_id').nullable(); // References repo_todo_categories.category_id (null = uncategorized)
    table.text('content').notNullable(); // The todo content/description
    table.integer('order_index').notNullable().defaultTo(0); // For drag-and-drop ordering within category
    table.boolean('is_completed').notNullable().defaultTo(false);
    table.text('linked_draft_id').nullable(); // References task_drafts.draft_id when converted to plan
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    // Indexes for common queries
    table.index('user_id');
    table.index('repository');
    table.index('category_id');
    table.index('linked_draft_id');
    table.index(['user_id', 'repository']);
    table.index(['user_id', 'repository', 'category_id', 'order_index']);
    table.index(['user_id', 'is_completed']);
  });
}

export async function down(knex) {
  // Drop in reverse order due to potential references
  await knex.schema.dropTableIfExists('repo_todos');
  await knex.schema.dropTableIfExists('repo_todo_categories');
}
