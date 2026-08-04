/**
 * Durable intake state for `/split` pull-request commands.
 *
 * Command receipts preserve the original intake disposition across webhook
 * redeliveries. Partial unique indexes enforce semantic deduplication (while
 * allowing failed requests to be retried) and the one-active-operation mutex
 * for each source PR, keyed by GitHub's immutable repository ID.
 */
export async function up(knex) {
  await knex.schema.createTable('pr_split_operations', (table) => {
    table.text('id').primary();
    table.bigInteger('repository_id').notNullable();
    table.text('repository').notNullable();
    table.integer('source_pr_number').notNullable();
    table.text('base_ref').notNullable();
    table.text('base_sha').notNullable();
    table.text('head_sha').notNullable();
    table.bigInteger('requester_id').notNullable();
    table.text('requester').notNullable();
    table.bigInteger('original_comment_id').notNullable();
    table.text('instruction').notNullable().defaultTo('');
    table.text('event_key').notNullable();
    table.text('dedupe_key').notNullable();
    table.text('status').notNullable().defaultTo('queued').checkIn([
      'queued',
      'running',
      'completed',
      'failed',
    ]);
    table.text('error_message').nullable();
    table.timestamp('started_at').nullable();
    table.timestamp('heartbeat_at').nullable();
    table.timestamp('lease_expires_at').nullable();
    table.text('lease_token').nullable();
    table.timestamp('finished_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['repository_id', 'source_pr_number']);
    table.index('status');
    table.index('original_comment_id');
    table.index('dedupe_key');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX pr_split_operations_event_key_unique
    ON pr_split_operations (event_key)
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX pr_split_operations_semantic_dedupe
    ON pr_split_operations (dedupe_key)
    WHERE status != 'failed'
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX pr_split_operations_one_active_per_pr
    ON pr_split_operations (repository_id, source_pr_number)
    WHERE status IN ('queued', 'running')
  `);

  await knex.schema.createTable('pr_split_command_receipts', (table) => {
    table.text('event_key').primary();
    table.bigInteger('repository_id').notNullable();
    table.text('repository').notNullable();
    table.integer('source_pr_number').notNullable();
    table.bigInteger('requester_id').notNullable();
    table.text('requester').notNullable();
    table.bigInteger('original_comment_id').notNullable();
    table.text('instruction').notNullable().defaultTo('');
    table.text('outcome').notNullable().checkIn([
      'processing',
      'disabled',
      'unauthorized',
      'closed',
      'invalid',
      'queued',
      'duplicate',
      'active',
    ]);
    table.text('duplicate_kind').nullable().checkIn(['event', 'semantic']);
    table.text('operation_id')
      .nullable()
      .references('id')
      .inTable('pr_split_operations')
      .onDelete('SET NULL');
    table.text('response_state').notNullable().defaultTo('pending').checkIn([
      'pending',
      'claimed',
      'posted',
    ]);
    table.text('response_claim_token').nullable();
    table.timestamp('response_claimed_at').nullable();
    table.bigInteger('response_comment_id').nullable();
    table.timestamp('response_posted_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['repository_id', 'original_comment_id']);
    table.index(['repository_id', 'source_pr_number']);
    table.index('operation_id');
    table.index('response_state');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('pr_split_command_receipts');
  await knex.schema.dropTableIfExists('pr_split_operations');
}
