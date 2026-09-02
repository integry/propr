/**
 * Provider-native goal executions (issue #2010).
 *
 * A goal is a durable user intent; an execution is the concrete, fenced
 * provider session that owns that intent.  Keeping these separate is what lets
 * a replacement controller resume the exact provider thread and worktree
 * without deriving either identity from Redis, a queue job, or a container.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function isoNow(knex) {
  return knex.raw(`(${ISO_NOW_SQL})`);
}

const EXECUTION_STATES = [
  'allocated', 'starting', 'active', 'pausing', 'paused', 'interrupted',
  'completing', 'completed', 'failed', 'cancelled',
];

const ARTIFACT_KINDS = [
  'epic_pr', 'sub_epic', 'implementation_issue', 'implementation_pr',
];

export async function up(knex) {
  await knex.schema.createTable('goal_runtime_executions', (table) => {
    table.text('execution_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.integer('attempt_number').notNullable();
    table.integer('schema_version').notNullable().defaultTo(1);
    table.text('state').notNullable().defaultTo('allocated').checkIn(EXECUTION_STATES);
    table.text('agent').notNullable();
    table.text('effective_model').notNullable();
    table.text('provider_session_id').nullable();
    table.text('provider_thread_id').nullable();
    table.text('runtime_id').nullable();
    table.text('worktree_id').notNullable();
    table.text('repository').notNullable();
    table.text('base_branch').notNullable();
    table.text('head_branch').notNullable();
    table.text('policy_json').notNullable();
    table.text('policy_hash').notNullable();
    table.text('last_checkpoint').nullable();
    table.integer('last_native_event_sequence').notNullable().defaultTo(0);
    table.integer('lease_generation').notNullable();
    table.text('heartbeat_at').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.foreign('goal_id').references('goal_id').inTable('goals')
      .onUpdate('RESTRICT').onDelete('CASCADE');
    table.unique(['goal_id', 'attempt_number'], {
      indexName: 'goal_runtime_executions_goal_attempt_idx',
    });
    table.index(['state', 'heartbeat_at'], 'goal_runtime_executions_recovery_idx');
    table.index(['repository', 'state'], 'goal_runtime_executions_capacity_idx');
    table.check(
      "typeof(attempt_number) = 'integer' AND attempt_number >= 1 AND schema_version = 1 AND typeof(lease_generation) = 'integer' AND lease_generation >= 1 AND typeof(last_native_event_sequence) = 'integer' AND last_native_event_sequence >= 0",
      {},
      'goal_runtime_executions_integer_check'
    );
    table.check(
      "json_valid(policy_json) AND length(policy_json) <= 16384 AND length(policy_hash) = 64",
      {},
      'goal_runtime_executions_policy_check'
    );
    table.check(
      "length(execution_id) BETWEEN 1 AND 255 AND length(agent) BETWEEN 1 AND 255 AND length(effective_model) BETWEEN 1 AND 255 AND length(worktree_id) BETWEEN 1 AND 255 AND length(repository) BETWEEN 1 AND 255 AND length(base_branch) BETWEEN 1 AND 255 AND length(head_branch) BETWEEN 1 AND 255 AND (provider_session_id IS NULL OR length(provider_session_id) BETWEEN 1 AND 255) AND (provider_thread_id IS NULL OR length(provider_thread_id) BETWEEN 1 AND 255) AND (runtime_id IS NULL OR length(runtime_id) BETWEEN 1 AND 255)",
      {},
      'goal_runtime_executions_text_check'
    );
  });

  await knex.schema.createTable('goal_reported_artifacts', (table) => {
    table.text('artifact_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('execution_id').notNullable();
    table.text('artifact_key').notNullable();
    table.text('kind').notNullable().checkIn(ARTIFACT_KINDS);
    table.text('repository').notNullable();
    table.text('external_ref').notNullable();
    table.text('url').nullable();
    table.text('head_branch').nullable();
    table.text('base_branch').nullable();
    table.text('head_sha').nullable();
    table.text('state').nullable();
    table.boolean('draft').nullable();
    table.text('marker').notNullable();
    // NULL for ordinary artifacts and the constant "final" for the one final
    // epic PR. SQLite uniqueness permits multiple NULLs but only one final row.
    table.text('final_slot').nullable();
    table.integer('lease_generation').notNullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.foreign('goal_id').references('goal_id').inTable('goals')
      .onUpdate('RESTRICT').onDelete('CASCADE');
    table.foreign('execution_id').references('execution_id').inTable('goal_runtime_executions')
      .onUpdate('RESTRICT').onDelete('CASCADE');
    table.unique(['goal_id', 'artifact_key'], {
      indexName: 'goal_reported_artifacts_goal_key_idx',
    });
    table.unique(['goal_id', 'final_slot'], {
      indexName: 'goal_reported_artifacts_final_idx',
    });
    table.index(['repository', 'external_ref'], 'goal_reported_artifacts_external_idx');
    table.check("final_slot IS NULL OR final_slot = 'final'", {}, 'goal_reported_artifacts_final_check');
    table.check("draft IS NULL OR draft IN (0, 1)", {}, 'goal_reported_artifacts_draft_check');
    table.check(
      "length(artifact_id) BETWEEN 1 AND 255 AND length(artifact_key) BETWEEN 1 AND 255 AND length(repository) BETWEEN 1 AND 255 AND length(external_ref) BETWEEN 1 AND 255 AND length(marker) BETWEEN 1 AND 2048 AND (url IS NULL OR length(url) <= 2048)",
      {},
      'goal_reported_artifacts_text_check'
    );
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goal_reported_artifacts');
  await knex.schema.dropTableIfExists('goal_runtime_executions');
}
