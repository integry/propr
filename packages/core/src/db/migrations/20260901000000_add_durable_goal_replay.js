/**
 * Durable goal event/replay/message projections (issue #2008).
 *
 * This migration deliberately owns only append/audit and read projections. It
 * does not mutate controller plan/node/attempt authority owned by the goal
 * reconciler. All derived rows can be rebuilt from the retained event log and
 * its compaction checkpoints.
 */

const ISO_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export async function up(knex) {
  if (!await knex.schema.hasTable('goal_events')) {
    throw new Error('Durable goal replay requires the #2018 goal control-plane foundation');
  }
  for (const [column, add] of [
    ['schema_version', table => table.integer('schema_version').notNullable().defaultTo(1)],
    ['source_session_id', table => table.text('source_session_id').nullable()],
    ['source_turn_id', table => table.text('source_turn_id').nullable()],
    ['source_execution_id', table => table.text('source_execution_id').nullable()],
    ['source_attempt_id', table => table.text('source_attempt_id').nullable()],
    ['source_provider_sequence', table => table.integer('source_provider_sequence').nullable()],
    ['source_chunk_index', table => table.integer('source_chunk_index').nullable()],
    ['lease_generation', table => table.integer('lease_generation').nullable()],
    ['payload_bytes', table => table.integer('payload_bytes').notNullable().defaultTo(0)],
  ]) {
    if (!await knex.schema.hasColumn('goal_events', column)) {
      await knex.schema.alterTable('goal_events', add);
    }
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS goal_events_source_occurrence_idx
    ON goal_events (
      goal_id, source_session_id, source_turn_id, source_execution_id,
      source_attempt_id, source_provider_sequence, source_chunk_index,
      lease_generation
    )
    WHERE source_session_id IS NOT NULL
  `);
  await knex.raw(`
    UPDATE goal_events
    SET source_session_id = COALESCE(source_session_id, 'migration:event:' || id),
        source_turn_id = COALESCE(source_turn_id, 'migration:event:' || id),
        source_execution_id = COALESCE(source_execution_id, 'migration:event:' || id),
        source_attempt_id = COALESCE(source_attempt_id, 'migration:event:' || id),
        source_provider_sequence = COALESCE(source_provider_sequence, sequence),
        source_chunk_index = COALESCE(source_chunk_index, 0),
        lease_generation = COALESCE(lease_generation, MAX(lease_epoch, 1))
    WHERE source_session_id IS NULL OR source_turn_id IS NULL
       OR source_execution_id IS NULL OR source_attempt_id IS NULL
       OR source_provider_sequence IS NULL OR source_chunk_index IS NULL
       OR lease_generation IS NULL
  `);
  await knex('goal_events').where('payload_bytes', 0).whereNotNull('payload_json')
    .update({ payload_bytes: knex.raw('length(CAST(payload_json AS BLOB))') });

  for (const [column, add] of [
    ['current_turn_id', table => table.text('current_turn_id').nullable()],
    ['current_execution_id', table => table.text('current_execution_id').nullable()],
    ['current_attempt_id', table => table.text('current_attempt_id').nullable()],
  ]) {
    if (!await knex.schema.hasColumn('goal_provider_sessions', column)) {
      await knex.schema.alterTable('goal_provider_sessions', add);
    }
  }

  await rebuildMessages(knex);
  await knex('goal_messages').whereIn('state', ['delivering', 'delivered']).update({
    state: 'failed', failed_at: knex.ref('created_at'),
    last_error: 'Migration recovery required: provider acknowledgement identity was not durable',
  });

  await knex.schema.createTable('goal_event_state', table => {
    table.text('goal_id').primary().notNullable();
    table.integer('high_watermark').notNullable().defaultTo(0);
    table.integer('min_retained_sequence').notNullable().defaultTo(1);
    table.integer('projection_sequence').notNullable().defaultTo(0);
    table.integer('checkpoint_sequence').notNullable().defaultTo(0);
    table.text('updated_at').notNullable().defaultTo(knex.raw(`(${ISO_NOW_SQL})`));
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });
  await knex.raw(`
    INSERT INTO goal_event_state (
      goal_id, high_watermark, min_retained_sequence, projection_sequence,
      checkpoint_sequence, updated_at
    )
    SELECT g.goal_id, COALESCE(MAX(e.sequence), 0), 1, COALESCE(MAX(e.sequence), 0), 0,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM goals g LEFT JOIN goal_events e ON e.goal_id = g.goal_id
    GROUP BY g.goal_id
  `);

  await knex.schema.createTable('goal_event_quarantine', table => {
    table.increments('id').primary();
    table.text('goal_id').notNullable();
    table.text('idempotency_key').notNullable();
    table.text('event_type').nullable();
    table.text('reason').notNullable();
    table.text('payload_digest').notNullable();
    table.text('created_at').notNullable().defaultTo(knex.raw(`(${ISO_NOW_SQL})`));
    table.unique(['goal_id', 'idempotency_key']);
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });

  await knex.schema.createTable('goal_usage_occurrences', table => {
    table.increments('id').primary();
    table.text('goal_id').notNullable();
    table.text('provider').notNullable();
    table.text('model').notNullable();
    table.text('session_id').notNullable();
    table.text('execution_id').notNullable();
    table.text('attempt_id').notNullable();
    table.text('occurrence_id').notNullable();
    table.integer('input_tokens').notNullable().defaultTo(0);
    table.integer('output_tokens').notNullable().defaultTo(0);
    table.integer('cache_read_tokens').notNullable().defaultTo(0);
    table.integer('cache_write_tokens').notNullable().defaultTo(0);
    table.integer('reasoning_tokens').notNullable().defaultTo(0);
    table.integer('reported_input_tokens').notNullable().defaultTo(0);
    table.integer('reported_output_tokens').notNullable().defaultTo(0);
    table.integer('reported_cache_read_tokens').notNullable().defaultTo(0);
    table.integer('reported_cache_write_tokens').notNullable().defaultTo(0);
    table.integer('reported_reasoning_tokens').notNullable().defaultTo(0);
    table.boolean('cumulative').notNullable().defaultTo(false);
    table.text('content_digest').notNullable().defaultTo('migration-recovery-required');
    table.integer('provider_sequence').notNullable().defaultTo(0);
    table.integer('event_sequence').notNullable();
    table.text('created_at').notNullable().defaultTo(knex.raw(`(${ISO_NOW_SQL})`));
    table.unique(
      ['goal_id', 'provider', 'model', 'session_id', 'execution_id', 'attempt_id', 'occurrence_id'],
      { indexName: 'goal_usage_occurrence_identity_idx' }
    );
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });
  await knex.raw(`
    CREATE UNIQUE INDEX goal_usage_occurrence_stable_idx
    ON goal_usage_occurrences (goal_id, session_id, execution_id, attempt_id, occurrence_id)
  `);

  await knex.schema.createTable('goal_usage_watermarks', table => {
    table.text('goal_id').notNullable();
    table.text('provider').notNullable();
    table.text('model').notNullable();
    table.text('session_id').notNullable();
    table.text('execution_id').notNullable();
    table.text('attempt_id').notNullable();
    table.integer('input_tokens').notNullable().defaultTo(0);
    table.integer('output_tokens').notNullable().defaultTo(0);
    table.integer('cache_read_tokens').notNullable().defaultTo(0);
    table.integer('cache_write_tokens').notNullable().defaultTo(0);
    table.integer('reasoning_tokens').notNullable().defaultTo(0);
    table.integer('input_tokens_sequence').notNullable().defaultTo(-1);
    table.integer('output_tokens_sequence').notNullable().defaultTo(-1);
    table.integer('cache_read_tokens_sequence').notNullable().defaultTo(-1);
    table.integer('cache_write_tokens_sequence').notNullable().defaultTo(-1);
    table.integer('reasoning_tokens_sequence').notNullable().defaultTo(-1);
    table.primary(['goal_id', 'provider', 'model', 'session_id', 'execution_id', 'attempt_id']);
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });

  await knex.schema.createTable('goal_external_projections', table => {
    table.text('goal_id').notNullable();
    table.text('entity_type').notNullable();
    table.integer('entity_number').notNullable();
    table.text('status').notNullable();
    table.integer('event_sequence').notNullable();
    table.text('updated_at').notNullable();
    table.primary(['goal_id', 'entity_type', 'entity_number']);
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });

  await knex.schema.createTable('goal_provider_todos', table => {
    table.text('goal_id').notNullable();
    table.text('session_id').notNullable();
    table.text('todo_id').notNullable();
    table.text('body').notNullable();
    table.text('status').notNullable();
    table.integer('event_sequence').notNullable();
    table.primary(['goal_id', 'session_id', 'todo_id']);
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });

  await knex.schema.createTable('goal_compaction_checkpoints', table => {
    table.text('goal_id').notNullable();
    table.integer('through_sequence').notNullable();
    table.text('content_digest').notNullable();
    table.integer('removed_event_count').notNullable();
    table.integer('removed_payload_bytes').notNullable();
    table.text('created_at').notNullable().defaultTo(knex.raw(`(${ISO_NOW_SQL})`));
    table.primary(['goal_id', 'through_sequence']);
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
  });

  if (!await knex.schema.hasColumn('goal_model_transitions', 'outcome')) {
    await knex.schema.alterTable('goal_model_transitions', table => {
      table.text('outcome').notNullable().defaultTo('pending');
      table.text('superseded_at').nullable();
    });
    await knex('goal_model_transitions').where('applied', 1).update({ outcome: 'applied' });
  }
}

async function rebuildMessages(knex) {
  if (await knex.schema.hasColumn('goal_messages', 'queue_ordinal')) return;
  await knex.raw('DROP INDEX IF EXISTS goal_messages_goal_sequence_idx');
  await knex.raw('DROP INDEX IF EXISTS goal_messages_goal_idempotency_idx');
  await knex.raw('DROP INDEX IF EXISTS goal_messages_delivery_idx');
  await knex.schema.renameTable('goal_messages', 'goal_messages_foundation');
  await knex.schema.createTable('goal_messages', table => {
    table.text('message_id').primary().notNullable();
    table.text('goal_id').notNullable();
    table.integer('sequence').notNullable();
    table.integer('queue_ordinal').notNullable();
    table.text('body').notNullable();
    table.text('predefined_kind').nullable();
    table.text('canned_action').nullable();
    table.text('author_user_id').nullable();
    table.text('state').notNullable().defaultTo('queued');
    table.text('claimed_by').nullable();
    table.text('claimed_controller_id').nullable();
    table.text('claimed_turn_id').nullable();
    table.text('claimed_execution_id').nullable();
    table.text('claimed_attempt_id').nullable();
    table.integer('claimed_provider_sequence').nullable();
    table.integer('claimed_chunk_index').nullable();
    table.integer('claimed_lease_generation').nullable();
    table.text('delivery_key').nullable();
    table.text('provider_idempotency_key').nullable();
    table.text('claimed_at').nullable();
    table.text('delivered_at').nullable();
    table.text('acknowledged_at').nullable();
    table.text('cancelled_at').nullable();
    table.text('failed_at').nullable();
    table.integer('delivery_attempts').notNullable().defaultTo(0);
    table.integer('retry_count').notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.text('idempotency_key').notNullable();
    table.integer('enqueue_event_sequence').nullable();
    table.integer('state_event_sequence').nullable();
    table.text('created_at').notNullable();
    table.check("state IN ('queued','delivering','delivered','acknowledged','failed','cancelled')");
    table.check("canned_action IS NULL OR canned_action IN ('whats_done','whats_left')");
    table.foreign('goal_id').references('goal_id').inTable('goals').onDelete('CASCADE');
    table.unique(['goal_id', 'sequence'], { indexName: 'goal_messages_goal_sequence_idx' });
    table.unique(['goal_id', 'queue_ordinal'], { indexName: 'goal_messages_goal_ordinal_idx' });
    table.unique(['goal_id', 'idempotency_key'], { indexName: 'goal_messages_goal_idempotency_idx' });
    table.index(['goal_id', 'state', 'queue_ordinal'], 'goal_messages_delivery_idx');
  });
  await knex.raw(`
    INSERT INTO goal_messages (
      message_id, goal_id, sequence, queue_ordinal, body, predefined_kind,
      state, delivered_at, acknowledged_at, delivery_attempts, retry_count,
      last_error, idempotency_key, created_at
    )
    SELECT message_id, goal_id, sequence, sequence, body, predefined_kind,
      state, delivered_at, acknowledged_at, delivery_attempts, 0,
      last_error, idempotency_key, created_at
    FROM goal_messages_foundation
  `);
  await knex.schema.dropTable('goal_messages_foundation');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('goal_compaction_checkpoints');
  await knex.schema.dropTableIfExists('goal_provider_todos');
  await knex.schema.dropTableIfExists('goal_external_projections');
  await knex.schema.dropTableIfExists('goal_usage_watermarks');
  await knex.schema.dropTableIfExists('goal_usage_occurrences');
  await knex.schema.dropTableIfExists('goal_event_quarantine');
  await knex.schema.dropTableIfExists('goal_event_state');
  await knex.raw('DROP INDEX IF EXISTS goal_events_source_occurrence_idx');
}
