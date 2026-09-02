/**
 * Retryable post-foundation repair for both branch initialization orders.
 * It installs the original leaf when that migration was previously recorded as
 * a no-op, and refuses to be recorded while the #2018 foundation is absent.
 */
import { up as installDurableReplay } from './20260901000000_add_durable_goal_replay.js';

const MESSAGE_COLUMNS = [
  ['claimed_controller_id', table => table.text('claimed_controller_id').nullable()],
  ['claimed_execution_id', table => table.text('claimed_execution_id').nullable()],
  ['claimed_attempt_id', table => table.text('claimed_attempt_id').nullable()],
  ['claimed_provider_sequence', table => table.integer('claimed_provider_sequence').nullable()],
  ['claimed_chunk_index', table => table.integer('claimed_chunk_index').nullable()],
  ['provider_idempotency_key', table => table.text('provider_idempotency_key').nullable()],
  ['claimed_at', table => table.text('claimed_at').nullable()],
];

const OCCURRENCE_COLUMNS = [
  ['reported_input_tokens', table => table.integer('reported_input_tokens').notNullable().defaultTo(0)],
  ['reported_output_tokens', table => table.integer('reported_output_tokens').notNullable().defaultTo(0)],
  ['reported_cache_read_tokens', table => table.integer('reported_cache_read_tokens').notNullable().defaultTo(0)],
  ['reported_cache_write_tokens', table => table.integer('reported_cache_write_tokens').notNullable().defaultTo(0)],
  ['reported_reasoning_tokens', table => table.integer('reported_reasoning_tokens').notNullable().defaultTo(0)],
  ['cumulative', table => table.boolean('cumulative').notNullable().defaultTo(false)],
  ['content_digest', table => table.text('content_digest').notNullable().defaultTo('migration-recovery-required')],
  ['provider_sequence', table => table.integer('provider_sequence').notNullable().defaultTo(0)],
];

const WATERMARK_COLUMNS = [
  'input_tokens_sequence', 'output_tokens_sequence', 'cache_read_tokens_sequence',
  'cache_write_tokens_sequence', 'reasoning_tokens_sequence',
];

export async function up(knex) {
  if (!await knex.schema.hasTable('goal_events')) {
    throw new Error('Durable goal replay hardening requires the #2018 foundation');
  }
  if (!await knex.schema.hasTable('goal_event_state')) await installDurableReplay(knex);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS goal_provider_sessions_thread_unique_idx
    ON goal_provider_sessions (agent, provider_thread_id)
    WHERE provider_thread_id IS NOT NULL
  `);
  await addColumns(knex, 'goal_events', [
    ['source_namespace', table => table.text('source_namespace').notNullable().defaultTo('migration')],
  ]);
  await knex.raw('DROP INDEX IF EXISTS goal_events_source_occurrence_idx');
  await knex.raw(`
    CREATE UNIQUE INDEX goal_events_source_occurrence_idx
    ON goal_events (
      goal_id, source_namespace, source_session_id, source_turn_id, source_execution_id,
      source_attempt_id, source_provider_sequence, source_chunk_index, lease_generation
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
  await addColumns(knex, 'goal_messages', MESSAGE_COLUMNS);
  await knex('goal_messages').whereIn('state', ['delivering', 'delivered'])
    .where(builder => builder.whereNull('claimed_by').orWhereNull('claimed_controller_id')
      .orWhereNull('claimed_turn_id').orWhereNull('claimed_execution_id')
      .orWhereNull('claimed_attempt_id').orWhereNull('claimed_lease_generation')
      .orWhereNull('delivery_key').orWhereNull('provider_idempotency_key')
      .orWhereNull('claimed_provider_sequence').orWhereNull('claimed_chunk_index'))
    .update({
      state: 'failed', failed_at: knex.ref('created_at'),
      last_error: 'Migration recovery required: provider delivery identity was incomplete',
    });
  await addColumns(knex, 'goal_usage_occurrences', OCCURRENCE_COLUMNS);
  await addColumns(knex, 'goal_usage_watermarks', WATERMARK_COLUMNS.map(column => [
    column, table => table.integer(column).notNullable().defaultTo(-1),
  ]));
  await addColumns(knex, 'goal_provider_todos', [
    ['source_kind', table => table.text('source_kind').notNullable().defaultTo('todo')],
    ['item_ordinal', table => table.integer('item_ordinal').notNullable().defaultTo(0)],
    ['updated_at', table => table.text('updated_at').notNullable().defaultTo('1970-01-01T00:00:00.000Z')],
  ]);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS goal_usage_occurrence_stable_idx
    ON goal_usage_occurrences (goal_id, session_id, execution_id, attempt_id, occurrence_id)
  `);
}

async function addColumns(knex, tableName, columns) {
  for (const [column, add] of columns) {
    if (!await knex.schema.hasColumn(tableName, column)) {
      await knex.schema.alterTable(tableName, add);
    }
  }
}

export async function down() {
  // The durable replay leaf owns table teardown. This repair is forward-only.
}
