/**
 * Minimal durable envelope for native coding-agent goals. Task history, output,
 * todos, token usage, containers and execution logs remain in their existing
 * stores and are referenced through current_task_id.
 */
export async function up(knex) {
  await knex.schema.createTable('goals', table => {
    table.uuid('goal_id').primary();
    table.string('owner_id', 255).notNullable();
    table.string('owner_login', 255).notNullable();
    table.string('repository', 255).notNullable();
    table.text('objective').notNullable();
    table.string('launch_strategy', 20).notNullable();
    table.text('initial_prompt').notNullable();
    table.string('base_branch', 255);
    table.string('branch_name', 255);
    table.text('worktree_path');
    table.string('agent_id', 255).notNullable();
    table.string('agent_alias', 255).notNullable();
    table.string('agent_type', 50).notNullable();
    table.string('requested_model', 255).notNullable();
    table.string('effective_model', 255);
    table.integer('max_parallel_tasks');
    table.boolean('ultrafix');
    table.string('desired_state', 20).notNullable().defaultTo('running');
    table.string('result_state', 20);
    table.string('current_task_id', 255).notNullable().unique();
    table.string('session_id', 255);
    table.string('conversation_id', 255);
    table.integer('run_generation').notNullable().defaultTo(0);
    table.integer('final_pr_number');
    table.text('final_pr_url');
    table.json('artifact_refs').defaultTo('[]');
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('started_at');
    table.timestamp('paused_at');
    table.bigInteger('paused_ms').notNullable().defaultTo(0);
    table.timestamp('completed_at');

    table.index(['owner_id', 'updated_at']);
    table.index(['desired_state', 'result_state']);
    table.index('repository');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goals');
}
