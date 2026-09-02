/**
 * Durable goal control plane (issue #2006, part of epic #2003).
 *
 * Long-running goals require an owned, durable source of truth instead of the
 * expiring Redis records and one-shot agent jobs used by tasks. This migration
 * introduces ten goal-domain tables: goal identity/lifecycle and request
 * idempotency, the hierarchical node
 * tree with dependencies, provider sessions, an append-only per-goal event log,
 * ordered corrective messages, and the auditable state/model transition and
 * pause-interval history from which elapsed/active/paused time is derived.
 *
 * Invariants that require multi-row reasoning (monotonic sequence allocation,
 * fenced lease commits, optimistic version bumps, transition validity) are
 * enforced by the repository/service layer inside transactions. The schema
 * enforces referential integrity, enumerations, uniqueness, and non-negativity
 * so a corrupt row cannot be persisted even if application code regresses.
 *
 * Forward-compatible: it only adds tables and leaves existing task/planner/issue
 * schema untouched.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function isoNow(knex) {
  return knex.raw(`(${ISO_NOW_SQL})`);
}

const GOAL_STATES = [
  'queued', 'planning', 'running', 'pausing', 'paused', 'cancelling', 'recovering',
  'completing', 'completed', 'failed', 'cancelled',
];
const NODE_KINDS = ['root_epic', 'sub_epic', 'implementation_issue', 'implementation_pr'];
const NODE_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled'];
const EVENT_KINDS = ['lifecycle', 'output', 'domain'];
const MERGE_POLICIES = ['manual', 'auto', 'auto_squash'];

export async function up(knex) {
  await knex.schema.createTable('goals', (table) => {
    table.text('goal_id').notNullable().primary();
    table.text('owner_user_id').notNullable();
    table.text('repository').notNullable();
    table.text('objective').notNullable();
    table.text('state').notNullable().defaultTo('queued').checkIn(GOAL_STATES);
    table.text('agent').notNullable();
    table.text('requested_model').notNullable();
    table.text('effective_model').notNullable();
    table.integer('max_active_tasks').notNullable().defaultTo(3);
    table.boolean('ultrafix_enabled').notNullable().defaultTo(false);
    table.integer('ultrafix_goal').nullable();
    table.integer('ultrafix_max_cycles').nullable();
    table
      .text('merge_policy')
      .notNullable()
      .defaultTo('manual')
      .checkIn(MERGE_POLICIES);
    table.integer('version').notNullable().defaultTo(1);
    // Fenced controller lease. A holder owns the goal for the epoch it claimed;
    // a takeover strictly increases the epoch so stale holders can be detected.
    table.text('lease_owner').nullable();
    table.integer('lease_epoch').notNullable().defaultTo(0);
    table.text('lease_expires_at').nullable();
    table.text('terminal_reason').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      'typeof(max_active_tasks) = \'integer\' AND max_active_tasks >= 1 AND max_active_tasks <= 20',
      {},
      'goals_max_active_tasks_check'
    );
    table.check(
      'typeof(version) = \'integer\' AND version >= 1',
      {},
      'goals_version_check'
    );
    table.check(
      'typeof(lease_epoch) = \'integer\' AND lease_epoch >= 0',
      {},
      'goals_lease_epoch_check'
    );
    table.check(
      'ultrafix_enabled IN (0, 1)',
      {},
      'goals_ultrafix_boolean_check'
    );
    table.check(
      "terminal_reason IS NULL OR terminal_reason IN ('objective_met', 'user_cancelled', 'unrecoverable_error', 'concurrency_exhausted', 'superseded')",
      {},
      'goals_terminal_reason_check'
    );
    table.check(
      '(ultrafix_enabled = 0 AND ultrafix_goal IS NULL AND ultrafix_max_cycles IS NULL) OR (ultrafix_enabled = 1 AND typeof(ultrafix_goal) = \'integer\' AND ultrafix_goal BETWEEN 1 AND 10 AND typeof(ultrafix_max_cycles) = \'integer\' AND ultrafix_max_cycles BETWEEN 1 AND 20)',
      {},
      'goals_ultrafix_settings_check'
    );
    table.check(
      "length(trim(goal_id)) BETWEEN 1 AND 255 AND length(trim(owner_user_id)) BETWEEN 1 AND 255 AND length(trim(repository)) BETWEEN 1 AND 255 AND length(trim(objective)) BETWEEN 1 AND 4000 AND length(agent) BETWEEN 1 AND 255 AND length(requested_model) BETWEEN 1 AND 255 AND length(effective_model) BETWEEN 1 AND 255 AND (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 255)",
      {},
      'goals_required_text_check'
    );

    table.index('owner_user_id', 'goals_owner_idx');
    table.index('repository', 'goals_repository_idx');
    table.index(['owner_user_id', 'repository'], 'goals_owner_repository_idx');
    table.index(['owner_user_id', 'state'], 'goals_owner_state_idx');
  });

  await knex.schema.createTable('goal_idempotency_keys', (table) => {
    table.text('owner_user_id').notNullable();
    table.text('operation').notNullable();
    table.text('idempotency_key').notNullable();
    table.text('request_hash').notNullable();
    table.text('claim_token').nullable();
    // Nullable until the claimant commits its effect. The primary key itself is
    // the atomic reservation used by cross-connection idempotent requests.
    table.text('goal_id').nullable();
    table.text('response_json').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.primary(['owner_user_id', 'operation', 'idempotency_key']);
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
    table.index(['goal_id', 'operation'], 'goal_idempotency_goal_operation_idx');
    table.check(
      'length(owner_user_id) BETWEEN 1 AND 255 AND length(operation) BETWEEN 1 AND 512 AND length(idempotency_key) BETWEEN 1 AND 255 AND (claim_token IS NULL OR length(claim_token) BETWEEN 1 AND 255)',
      {},
      'goal_idempotency_text_bounds_check'
    );
  });

  await knex.schema.createTable('goal_nodes', (table) => {
    table.text('node_id').notNullable().primary();
    // Preserve whether the caller explicitly selected an identifier. The
    // generated node_id alone cannot distinguish an omitted ID from a retry
    // that supplies the generated response ID, which are different requests.
    table.text('requested_node_id').nullable();
    table.text('goal_id').notNullable();
    table.text('parent_node_id').nullable();
    table.text('kind').notNullable().checkIn(NODE_KINDS);
    // Stable per-goal idempotency key so replanning does not duplicate nodes.
    table.text('idempotency_key').notNullable();
    // External GitHub identity (issue/PR number and its kind), when materialized.
    table.text('external_ref').nullable();
    table.text('external_kind').nullable();
    table.text('title').nullable();
    table.text('status').notNullable().defaultTo('pending').checkIn(NODE_STATUSES);
    table.integer('attempt_count').notNullable().defaultTo(0);
    table.integer('order_index').notNullable().defaultTo(0);
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      'typeof(attempt_count) = \'integer\' AND attempt_count >= 0',
      {},
      'goal_nodes_attempt_count_check'
    );
    table.check(
      'typeof(order_index) = \'integer\' AND order_index >= 0',
      {},
      'goal_nodes_order_index_check'
    );
    table.check(
      'length(node_id) BETWEEN 1 AND 255 AND (requested_node_id IS NULL OR length(requested_node_id) BETWEEN 1 AND 255) AND length(idempotency_key) BETWEEN 1 AND 255 AND (parent_node_id IS NULL OR length(parent_node_id) BETWEEN 1 AND 255) AND (external_ref IS NULL OR length(external_ref) <= 255) AND (external_kind IS NULL OR length(external_kind) <= 255)',
      {},
      'goal_nodes_text_bounds_check'
    );

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');
    table.unique(['goal_id', 'node_id'], {
      indexName: 'goal_nodes_goal_node_idx',
    });
    table
      .foreign(['goal_id', 'parent_node_id'])
      .references(['goal_id', 'node_id'])
      .inTable('goal_nodes')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.unique(['goal_id', 'idempotency_key'], {
      indexName: 'goal_nodes_goal_idempotency_idx',
    });
    table.index(['goal_id', 'parent_node_id', 'order_index'], 'goal_nodes_tree_idx');
    table.index(['goal_id', 'status'], 'goal_nodes_status_idx');
  });

  await knex.schema.createTable('goal_node_dependencies', (table) => {
    table.text('goal_id').notNullable();
    table.text('node_id').notNullable();
    table.text('depends_on_node_id').notNullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.primary(['goal_id', 'node_id', 'depends_on_node_id']);
    table.check(
      'node_id <> depends_on_node_id',
      {},
      'goal_node_dependencies_no_self_edge_check'
    );

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');
    table
      .foreign(['goal_id', 'node_id'])
      .references(['goal_id', 'node_id'])
      .inTable('goal_nodes')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');
    table
      .foreign(['goal_id', 'depends_on_node_id'])
      .references(['goal_id', 'node_id'])
      .inTable('goal_nodes')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.index('goal_id', 'goal_node_dependencies_goal_idx');
    table.index('depends_on_node_id', 'goal_node_dependencies_dependency_idx');
  });

  await knex.schema.createTable('goal_provider_sessions', (table) => {
    table.text('session_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('agent').notNullable();
    table.text('provider_thread_id').nullable();
    table.text('runtime_id').nullable();
    table.text('worktree_id').nullable();
    table.text('last_checkpoint').nullable();
    table.text('effective_model').notNullable();
    table.text('recovery_metadata_json').nullable();
    // Fenced lease generation this session belongs to; a stale generation must
    // not resume authoritative provider work after a controller takeover.
    table.integer('lease_generation').notNullable().defaultTo(0);
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      'typeof(lease_generation) = \'integer\' AND lease_generation >= 0',
      {},
      'goal_provider_sessions_lease_generation_check'
    );
    table.check(
      'length(session_id) BETWEEN 1 AND 255 AND length(agent) BETWEEN 1 AND 255 AND (provider_thread_id IS NULL OR length(provider_thread_id) <= 255) AND (runtime_id IS NULL OR length(runtime_id) <= 255) AND (worktree_id IS NULL OR length(worktree_id) <= 255)',
      {},
      'goal_provider_sessions_text_bounds_check'
    );
    table.check(
      'recovery_metadata_json IS NULL OR (json_valid(recovery_metadata_json) AND length(recovery_metadata_json) <= 4096)',
      {},
      'goal_provider_sessions_recovery_metadata_check'
    );

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.unique(['goal_id', 'agent'], {
      indexName: 'goal_provider_sessions_goal_agent_idx',
    });
  });

  await knex.schema.createTable('goal_events', (table) => {
    table.increments('id').primary();
    table.text('goal_id').notNullable();
    // Monotonic per-goal sequence; unique(goal_id, sequence) rejects gaps/dupes.
    table.integer('sequence').notNullable();
    table.text('kind').notNullable().checkIn(EVENT_KINDS);
    table.text('event_type').notNullable();
    table.text('payload_json').nullable();
    table.text('idempotency_key').notNullable();
    // Epoch of the controller lease that appended this event, for audit.
    table.integer('lease_epoch').notNullable().defaultTo(0);
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      'typeof(sequence) = \'integer\' AND sequence >= 1',
      {},
      'goal_events_sequence_check'
    );
    table.check(
      'length(event_type) BETWEEN 1 AND 255 AND length(idempotency_key) BETWEEN 1 AND 255',
      {},
      'goal_events_text_bounds_check'
    );

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.unique(['goal_id', 'sequence'], {
      indexName: 'goal_events_goal_sequence_idx',
    });
    table.unique(['goal_id', 'idempotency_key'], {
      indexName: 'goal_events_goal_idempotency_idx',
    });
    table.index(['goal_id', 'kind', 'sequence'], 'goal_events_goal_kind_idx');
  });

  await knex.schema.createTable('goal_messages', (table) => {
    table.text('message_id').notNullable().primary();
    table.text('goal_id').notNullable();
    // Ordered delivery position within the goal.
    table.integer('sequence').notNullable();
    table.text('body').notNullable();
    table.text('predefined_kind').nullable();
    // Kept as validated text rather than a database enum so the events follow-up
    // can add delivery states without rebuilding this table.
    table.text('state').notNullable().defaultTo('queued');
    table.text('delivered_at').nullable();
    table.text('acknowledged_at').nullable();
    table.integer('delivery_attempts').notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.text('idempotency_key').notNullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      'typeof(sequence) = \'integer\' AND sequence >= 1',
      {},
      'goal_messages_sequence_check'
    );
    table.check(
      'length(trim(body)) BETWEEN 1 AND 4000',
      {},
      'goal_messages_body_check'
    );
    table.check(
      "state IN ('queued', 'delivered', 'acknowledged') AND length(message_id) BETWEEN 1 AND 255 AND length(idempotency_key) BETWEEN 1 AND 255 AND (predefined_kind IS NULL OR length(predefined_kind) <= 255) AND (acknowledged_at IS NULL OR delivered_at IS NOT NULL)",
      {},
      'goal_messages_state_consistency_check'
    );
    table.check(
      "typeof(delivery_attempts) = 'integer' AND delivery_attempts >= 0",
      {},
      'goal_messages_delivery_attempts_check'
    );

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.unique(['goal_id', 'sequence'], {
      indexName: 'goal_messages_goal_sequence_idx',
    });
    table.unique(['goal_id', 'idempotency_key'], {
      indexName: 'goal_messages_goal_idempotency_idx',
    });
    table.index(['goal_id', 'state', 'sequence'], 'goal_messages_delivery_idx');
  });

  await knex.schema.createTable('goal_state_transitions', (table) => {
    table.increments('id').primary();
    table.text('goal_id').notNullable();
    table.text('from_state').notNullable().checkIn(GOAL_STATES);
    table.text('to_state').notNullable().checkIn(GOAL_STATES);
    table.text('reason').nullable();
    table.integer('lease_epoch').notNullable().defaultTo(0);
    table.text('created_at').notNullable().defaultTo(isoNow(knex));

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.index(['goal_id', 'created_at'], 'goal_state_transitions_goal_idx');
    table.check(
      'reason IS NULL OR length(reason) <= 1000',
      {},
      'goal_state_transitions_reason_bounds_check'
    );
  });

  await knex.schema.createTable('goal_model_transitions', (table) => {
    table.increments('id').primary();
    table.text('goal_id').notNullable();
    table.text('previous_model').notNullable();
    table.text('requested_model').notNullable();
    table.text('effective_model').notNullable();
    // Requested changes are recorded unapplied until a runtime acknowledges the
    // change at a safe boundary, at which point the effective model advances.
    table.boolean('applied').notNullable().defaultTo(false);
    table.text('reason').nullable();
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('applied_at').nullable();

    table.check('applied IN (0, 1)', {}, 'goal_model_transitions_applied_check');

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.index(['goal_id', 'created_at'], 'goal_model_transitions_goal_idx');
    table.check(
      'length(previous_model) BETWEEN 1 AND 255 AND length(requested_model) BETWEEN 1 AND 255 AND length(effective_model) BETWEEN 1 AND 255 AND (reason IS NULL OR length(reason) <= 1000)',
      {},
      'goal_model_transitions_text_bounds_check'
    );
  });

  await knex.schema.createTable('goal_pause_intervals', (table) => {
    table.increments('id').primary();
    table.text('goal_id').notNullable();
    table.text('paused_at').notNullable();
    table.text('resumed_at').nullable();
    table.text('reason').nullable();

    table.check(
      'resumed_at IS NULL OR resumed_at >= paused_at',
      {},
      'goal_pause_intervals_order_check'
    );

    table
      .foreign('goal_id')
      .references('goal_id')
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');

    table.index(['goal_id', 'paused_at'], 'goal_pause_intervals_goal_idx');
    table.check(
      'reason IS NULL OR length(reason) <= 1000',
      {},
      'goal_pause_intervals_reason_bounds_check'
    );
  });

  // At most one open pause interval per goal so active-time accounting stays
  // unambiguous. A closed interval has resumed_at set and is not indexed here.
  await knex.raw(`
    CREATE UNIQUE INDEX goal_pause_intervals_open_idx
    ON goal_pause_intervals (goal_id)
    WHERE resumed_at IS NULL
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goal_pause_intervals');
  await knex.schema.dropTableIfExists('goal_model_transitions');
  await knex.schema.dropTableIfExists('goal_state_transitions');
  await knex.schema.dropTableIfExists('goal_messages');
  await knex.schema.dropTableIfExists('goal_events');
  await knex.schema.dropTableIfExists('goal_provider_sessions');
  await knex.schema.dropTableIfExists('goal_node_dependencies');
  await knex.schema.dropTableIfExists('goal_nodes');
  await knex.schema.dropTableIfExists('goal_idempotency_keys');
  await knex.schema.dropTableIfExists('goals');
}
