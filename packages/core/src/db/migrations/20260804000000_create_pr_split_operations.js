/**
 * Durable intake state for `/split` pull-request commands.
 *
 * Event identity makes webhook redelivery idempotent independently of the
 * semantic input key. Partial unique indexes enforce semantic deduplication
 * (while allowing failed requests to be retried) and the one-active-operation
 * mutex for each source PR.
 */
export async function up(knex) {
  await knex.schema.createTable('pr_split_operations', (table) => {
    table.text('id').primary();
    table.text('repository').notNullable();
    table.integer('source_pr_number').notNullable();
    table.text('base_ref').notNullable();
    table.text('base_sha').notNullable();
    table.text('head_sha').notNullable();
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
    table.timestamp('finished_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['repository', 'source_pr_number']);
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
    ON pr_split_operations (repository COLLATE NOCASE, source_pr_number)
    WHERE status IN ('queued', 'running')
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('pr_split_operations');
}
