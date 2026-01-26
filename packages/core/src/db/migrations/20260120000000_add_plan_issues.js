/**
 * Migration to add plan_issues table for tracking relationships between
 * plan drafts, GitHub issues, and PRs with their implementation states.
 */
export async function up(knex) {
  await knex.schema.createTable('plan_issues', (table) => {
    table.increments('id').primary();
    table.uuid('draft_id').notNullable();
    table.string('repository', 255).notNullable();
    table.integer('issue_number').notNullable();
    table.integer('pr_number').nullable();
    table.string('status', 50).notNullable().defaultTo('pending');
    table.string('agent_alias', 100).nullable();
    table.string('model_name', 100).nullable();
    table.integer('followup_count').defaultTo(0);
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now()).notNullable();

    // Foreign key to task_drafts
    table.foreign('draft_id')
      .references('draft_id')
      .inTable('task_drafts')
      .onDelete('CASCADE');

    // Indexes for efficient querying
    table.index('draft_id');
    table.index('repository');
    table.index('issue_number');
    table.index('pr_number');
    table.index('status');
    table.index('created_at');

    // Unique constraint to prevent duplicate entries for the same draft/issue combo
    table.unique(['draft_id', 'issue_number']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('plan_issues');
}
