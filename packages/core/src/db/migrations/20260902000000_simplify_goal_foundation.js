/**
 * Correct the unreleased goal foundation to one provider-native session.
 *
 * Fresh databases already receive the simplified schema from the edited
 * foundation migration. This migration is intentionally defensive so a
 * database which applied that earlier branch migration is upgraded to the
 * same product schema: hierarchy tables are removed, legacy automatic merge
 * selections become manual, and only the session matching goals.agent is
 * retained under a one-row-per-goal/composite ownership constraint.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function isoNow(knex) {
  return knex.raw(`(${ISO_NOW_SQL})`);
}

export async function up(knex) {
  if (!await knex.schema.hasTable('goals')) return;

  await knex('goals').whereNot('merge_policy', 'manual').update({ merge_policy: 'manual' });
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS goals_manual_merge_insert
    BEFORE INSERT ON goals
    WHEN NEW.merge_policy <> 'manual'
    BEGIN
      SELECT RAISE(ABORT, 'goal merge policy must be manual');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS goals_manual_merge_update
    BEFORE UPDATE OF merge_policy ON goals
    WHEN NEW.merge_policy <> 'manual'
    BEGIN
      SELECT RAISE(ABORT, 'goal merge policy must be manual');
    END
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS goals_goal_agent_idx
    ON goals (goal_id, agent)
  `);
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS goals_agent_immutable_update
    BEFORE UPDATE OF agent ON goals
    WHEN NEW.agent <> OLD.agent
    BEGIN
      SELECT RAISE(ABORT, 'goal agent is immutable');
    END
  `);

  if (await knex.schema.hasTable('goal_events')
    && !await knex.schema.hasColumn('goal_events', 'source')) {
    await knex.schema.alterTable('goal_events', (table) => {
      table.text('source').notNullable().defaultTo('internal');
    });
  }

  if (await knex.schema.hasTable('goal_provider_sessions')
    && !await knex.schema.hasColumn('goal_provider_sessions', 'native_status')) {
    await knex.schema.renameTable('goal_provider_sessions', 'goal_provider_sessions_legacy');
    await createProviderSessionsTable(knex);
    await knex.raw(`
      INSERT INTO goal_provider_sessions (
        session_id, goal_id, agent, provider_thread_id, runtime_id, worktree_id,
        last_checkpoint, native_status, requested_model, effective_model,
        recovery_metadata_json, lease_generation, created_at, updated_at
      )
      SELECT
        legacy.session_id, legacy.goal_id, legacy.agent,
        legacy.provider_thread_id, legacy.runtime_id, legacy.worktree_id,
        legacy.last_checkpoint, NULL, goals.requested_model,
        legacy.effective_model, legacy.recovery_metadata_json,
        legacy.lease_generation, legacy.created_at, legacy.updated_at
      FROM goal_provider_sessions_legacy AS legacy
      INNER JOIN goals
        ON goals.goal_id = legacy.goal_id AND goals.agent = legacy.agent
    `);
    await knex.schema.dropTable('goal_provider_sessions_legacy');
  } else if (!await knex.schema.hasTable('goal_provider_sessions')) {
    await createProviderSessionsTable(knex);
  }
  await createProviderSessionIdentityTriggers(knex);

  // Dependencies must be removed first because they reference goal_nodes.
  await knex.schema.dropTableIfExists('goal_node_dependencies');
  await knex.schema.dropTableIfExists('goal_nodes');
}

async function createProviderSessionsTable(knex) {
  await knex.schema.createTable('goal_provider_sessions', (table) => {
    table.text('session_id').notNullable().primary();
    table.text('goal_id').notNullable();
    table.text('agent').notNullable();
    table.text('provider_thread_id').nullable();
    table.text('runtime_id').nullable();
    table.text('worktree_id').nullable();
    table.text('last_checkpoint').nullable();
    table.text('native_status').nullable();
    table.text('requested_model').notNullable();
    table.text('effective_model').notNullable();
    table.text('recovery_metadata_json').nullable();
    table.integer('lease_generation').notNullable().defaultTo(0);
    table.text('created_at').notNullable().defaultTo(isoNow(knex));
    table.text('updated_at').notNullable().defaultTo(isoNow(knex));

    table.check(
      'typeof(lease_generation) = \'integer\' AND lease_generation >= 0',
      {},
      'goal_provider_sessions_lease_generation_check'
    );
    table.check(
      'length(session_id) BETWEEN 1 AND 255 AND length(agent) BETWEEN 1 AND 255 AND (provider_thread_id IS NULL OR length(provider_thread_id) <= 255) AND (runtime_id IS NULL OR length(runtime_id) <= 255) AND (worktree_id IS NULL OR length(worktree_id) <= 255) AND (native_status IS NULL OR length(native_status) <= 255) AND length(requested_model) BETWEEN 1 AND 255 AND length(effective_model) BETWEEN 1 AND 255',
      {},
      'goal_provider_sessions_text_bounds_check'
    );
    table.check(
      'recovery_metadata_json IS NULL OR (json_valid(recovery_metadata_json) AND length(recovery_metadata_json) <= 4096)',
      {},
      'goal_provider_sessions_recovery_metadata_check'
    );
    table
      .foreign(['goal_id', 'agent'])
      .references(['goal_id', 'agent'])
      .inTable('goals')
      .onUpdate('RESTRICT')
      .onDelete('CASCADE');
    table.unique(['goal_id'], {
      indexName: 'goal_provider_sessions_goal_idx',
    });
  });
}

async function createProviderSessionIdentityTriggers(knex) {
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS goal_provider_session_owner_immutable
    BEFORE UPDATE OF session_id, goal_id, agent ON goal_provider_sessions
    WHEN NEW.session_id IS NOT OLD.session_id
      OR NEW.goal_id IS NOT OLD.goal_id
      OR NEW.agent IS NOT OLD.agent
    BEGIN
      SELECT RAISE(ABORT, 'goal provider session ownership is immutable');
    END
  `);
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS goal_provider_session_identity_immutable
    BEFORE UPDATE OF provider_thread_id, worktree_id ON goal_provider_sessions
    WHEN (OLD.provider_thread_id IS NOT NULL
        AND NEW.provider_thread_id IS NOT OLD.provider_thread_id)
      OR (OLD.worktree_id IS NOT NULL AND NEW.worktree_id IS NOT OLD.worktree_id)
    BEGIN
      SELECT RAISE(ABORT, 'goal provider session identity is immutable once set');
    END
  `);
}

export async function down(knex) {
  // Deleted hierarchy data and normalized merge choices cannot be restored.
  // The original migration's down path still cleanly removes fresh schemas.
  await knex.raw('DROP TRIGGER IF EXISTS goals_manual_merge_update');
  await knex.raw('DROP TRIGGER IF EXISTS goals_manual_merge_insert');
  await knex.raw('DROP TRIGGER IF EXISTS goals_agent_immutable_update');
  await knex.raw('DROP TRIGGER IF EXISTS goal_provider_session_identity_immutable');
  await knex.raw('DROP TRIGGER IF EXISTS goal_provider_session_owner_immutable');
}
