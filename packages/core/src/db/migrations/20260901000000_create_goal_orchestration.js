/**
 * Durable orchestration state for goal controllers.
 *
 * Redis and delivery queues may wake a controller, but every decision which can
 * create remote state or consume capacity is represented here first.  Tables
 * deliberately reference the #2006 goal domain instead of creating a second
 * goal identity/state machine.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const now = (knex) => knex.raw(`(${ISO_NOW_SQL})`);

export async function up(knex) {
  await knex.schema.createTable('goal_plan_revisions', (table) => {
    table.text('goal_id').notNullable();
    table.integer('revision').notNullable();
    table.integer('schema_version').notNullable().defaultTo(1);
    table.text('plan_hash').notNullable();
    table.text('plan_json').notNullable();
    table.text('change_summary_json').notNullable().defaultTo('[]');
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.primary(['goal_id', 'revision']);
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
    table.unique(['goal_id', 'plan_hash']);
    table.check("typeof(revision) = 'integer' AND revision >= 1 AND schema_version = 1");
    table.check('json_valid(plan_json) AND json_valid(change_summary_json)');
  });

  await knex.schema.createTable('goal_node_specs', (table) => {
    table.text('node_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.integer('plan_revision').notNullable();
    table.text('correlation_key').notNullable();
    table.text('acceptance_criteria_json').notNullable();
    table.integer('estimate').notNullable();
    table.integer('depth').notNullable();
    table.text('base_branch').notNullable();
    table.text('head_branch').notNullable();
    table.boolean('no_code').notNullable().defaultTo(false);
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.text('updated_at').notNullable().defaultTo(now(knex));
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.foreign(['goal_id', 'plan_revision']).references(['goal_id', 'revision']).inTable('goal_plan_revisions').onDelete('RESTRICT');
    table.unique(['goal_id', 'correlation_key']);
    table.unique(['goal_id', 'head_branch']);
    table.check('json_valid(acceptance_criteria_json)');
    table.check("typeof(estimate) = 'integer' AND estimate >= 0 AND typeof(depth) = 'integer' AND depth >= 0 AND no_code IN (0, 1)");
  });

  await knex.schema.createTable('goal_attempts', (table) => {
    table.text('attempt_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.text('execution_id').notNullable();
    table.text('dispatch_identity').notNullable().unique();
    table.integer('attempt_number').notNullable();
    table.text('session_id').nullable();
    table.text('status').notNullable();
    table.text('requested_model').notNullable();
    table.text('effective_model').notNullable();
    table.integer('parallelism_snapshot').notNullable();
    table.boolean('ultrafix_enabled').notNullable();
    table.integer('ultrafix_goal').nullable();
    table.integer('ultrafix_max_cycles').nullable();
    table.integer('lease_generation').notNullable();
    table.text('external_ref').nullable();
    table.text('last_dispatch_error').nullable();
    table.text('started_at').nullable();
    table.text('finished_at').nullable();
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.text('updated_at').notNullable().defaultTo(now(knex));
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.unique(['goal_id', 'node_id', 'execution_id', 'attempt_number']);
    table.unique(['goal_id', 'node_id', 'attempt_number']);
    table.check("status IN ('reserved','dispatching','running','safe_boundary','succeeded','failed','cancelled','expired')");
    table.check("typeof(attempt_number) = 'integer' AND attempt_number >= 1 AND typeof(parallelism_snapshot) = 'integer' AND parallelism_snapshot >= 1 AND typeof(lease_generation) = 'integer' AND lease_generation >= 1");
    table.check("ultrafix_enabled IN (0,1) AND ((ultrafix_enabled = 0 AND ultrafix_goal IS NULL AND ultrafix_max_cycles IS NULL) OR (ultrafix_enabled = 1 AND ultrafix_goal BETWEEN 1 AND 10 AND ultrafix_max_cycles BETWEEN 1 AND 20))");
    table.index(['goal_id', 'status'], 'goal_attempts_goal_status_idx');
  });

  await knex.schema.createTable('goal_capacity_reservations', (table) => {
    table.text('reservation_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('repository').notNullable();
    table.text('node_id').notNullable();
    table.text('attempt_id').notNullable().unique();
    table.text('state').notNullable().defaultTo('reserved');
    table.integer('lease_generation').notNullable();
    table.text('expires_at').notNullable();
    table.text('released_at').nullable();
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.foreign('attempt_id').references('attempt_id').inTable('goal_attempts').onDelete('CASCADE');
    table.check("state IN ('reserved','active','released','expired')");
    table.index(['repository', 'state', 'expires_at'], 'goal_capacity_repository_idx');
    table.index(['goal_id', 'state', 'expires_at'], 'goal_capacity_goal_idx');
  });

  await knex.schema.createTable('goal_node_integrations', (table) => {
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.text('runtime_state').notNullable().defaultTo('pending');
    table.text('integration_state').notNullable().defaultTo('pending');
    table.text('head_sha').nullable();
    table.text('base_sha').nullable();
    table.text('policy_hash').nullable();
    table.text('merged_remote_id').nullable();
    table.text('runtime_completed_at').nullable();
    table.text('integrated_at').nullable();
    table.text('updated_at').notNullable().defaultTo(now(knex));
    table.primary(['goal_id', 'node_id']);
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.check("runtime_state IN ('pending','running','succeeded','failed','cancelled')");
    table.check("integration_state IN ('pending','awaiting_artifacts','awaiting_validation','ready_to_merge','integrated','no_diff','failed','cancelled')");
    table.index(['goal_id', 'integration_state'], 'goal_integrations_ready_idx');
  });

  await knex.schema.createTable('goal_branch_locks', (table) => {
    table.text('repository').notNullable();
    table.text('target_branch').notNullable();
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.text('owner').notNullable();
    table.integer('lease_generation').notNullable();
    table.text('expires_at').notNullable();
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.primary(['repository', 'target_branch']);
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
  });

  await knex.schema.createTable('goal_github_artifacts', (table) => {
    table.text('artifact_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.text('kind').notNullable();
    table.text('repository').notNullable();
    table.text('remote_id').nullable();
    table.integer('number').nullable();
    table.text('url').nullable();
    table.text('head_branch').nullable();
    table.text('base_branch').nullable();
    table.text('head_sha').nullable();
    table.text('base_sha').nullable();
    table.text('state').notNullable().defaultTo('expected');
    table.text('marker').notNullable();
    table.text('last_observed_at').nullable();
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.text('updated_at').notNullable().defaultTo(now(knex));
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.unique(['goal_id', 'node_id', 'kind']);
    table.unique(['repository', 'kind', 'remote_id']);
    table.unique('marker');
    table.check("kind IN ('issue','branch','pull_request','comment','label')");
    table.check("state IN ('expected','present','closed','merged','deleted','no_diff')");
    table.index(['goal_id', 'state'], 'goal_artifacts_goal_state_idx');
  });

  await knex.schema.createTable('goal_github_outbox', (table) => {
    table.text('operation_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.text('artifact_id').nullable();
    table.text('operation_kind').notNullable();
    table.text('idempotency_key').notNullable();
    table.text('marker').notNullable();
    table.text('payload_json').notNullable();
    table.text('state').notNullable().defaultTo('pending');
    table.integer('attempts').notNullable().defaultTo(0);
    table.text('claimed_by').nullable();
    table.integer('claim_generation').nullable();
    table.text('claim_token').nullable();
    table.text('claim_expires_at').nullable();
    table.text('last_error').nullable();
    table.text('available_at').notNullable().defaultTo(now(knex));
    table.text('completed_at').nullable();
    table.text('superseded_at').nullable();
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.text('updated_at').notNullable().defaultTo(now(knex));
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.foreign('artifact_id').references('artifact_id').inTable('goal_github_artifacts').onDelete('SET NULL');
    table.unique(['goal_id', 'idempotency_key']);
    table.check('json_valid(payload_json)');
    table.check("state IN ('pending','claimed','succeeded','failed','superseded') AND typeof(attempts) = 'integer' AND attempts >= 0");
    table.check("(state = 'claimed' AND claimed_by IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL) OR (state <> 'claimed' AND claimed_by IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)");
    table.index(['state', 'available_at'], 'goal_outbox_ready_idx');
  });

  await knex.schema.createTable('goal_validation_evidence', (table) => {
    table.text('evidence_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.text('kind').notNullable();
    table.text('head_sha').notNullable();
    table.text('base_sha').notNullable();
    table.text('policy_hash').notNullable();
    table.integer('cycle').notNullable().defaultTo(0);
    table.text('expected_checks_json').notNullable().defaultTo('[]');
    table.text('result_json').notNullable();
    table.text('status').notNullable();
    table.text('observed_at').notNullable();
    table.text('invalidated_at').nullable();
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.unique(['goal_id', 'node_id', 'kind', 'head_sha', 'base_sha', 'policy_hash', 'cycle']);
    table.check("kind IN ('ci','review','ultrafix','freshness') AND status IN ('pending','passed','failed')");
    table.check('json_valid(expected_checks_json) AND json_valid(result_json)');
    table.index(['goal_id', 'node_id', 'head_sha'], 'goal_evidence_exact_head_idx');
  });

  await knex.schema.createTable('goal_ultrafix_cycles', (table) => {
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.integer('cycle').notNullable();
    table.text('attempt_id').nullable();
    table.text('head_sha').notNullable();
    table.text('status').notNullable();
    table.integer('score').nullable();
    table.text('created_at').notNullable().defaultTo(now(knex));
    table.text('completed_at').nullable();
    table.primary(['goal_id', 'node_id', 'cycle']);
    table.foreign(['goal_id', 'node_id']).references(['goal_id', 'node_id']).inTable('goal_nodes').onDelete('CASCADE');
    table.foreign('attempt_id').references('attempt_id').inTable('goal_attempts').onDelete('CASCADE');
    table.check("typeof(cycle) = 'integer' AND cycle >= 1 AND status IN ('running','passed','failed','exhausted')");
  });

  await knex.schema.createTable('goal_controller_heartbeats', (table) => {
    table.text('goal_id').notNullable().primary();
    table.text('controller_id').notNullable();
    table.integer('lease_generation').notNullable();
    table.text('heartbeat_at').notNullable();
    table.text('scan_state_json').notNullable().defaultTo('{}');
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
    table.check('json_valid(scan_state_json)');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goal_controller_heartbeats');
  await knex.schema.dropTableIfExists('goal_ultrafix_cycles');
  await knex.schema.dropTableIfExists('goal_validation_evidence');
  await knex.schema.dropTableIfExists('goal_github_outbox');
  await knex.schema.dropTableIfExists('goal_github_artifacts');
  await knex.schema.dropTableIfExists('goal_branch_locks');
  await knex.schema.dropTableIfExists('goal_node_integrations');
  await knex.schema.dropTableIfExists('goal_capacity_reservations');
  await knex.schema.dropTableIfExists('goal_attempts');
  await knex.schema.dropTableIfExists('goal_node_specs');
  await knex.schema.dropTableIfExists('goal_plan_revisions');
}
