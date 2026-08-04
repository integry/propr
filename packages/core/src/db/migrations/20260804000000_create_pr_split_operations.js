/**
 * Durable intake state for `/split` pull-request commands.
 *
 * The dedupe key makes an identical request idempotent for a particular PR
 * head. The partial unique index is the database-level mutex that allows only
 * one queued/running operation for a source PR while permitting any number of
 * completed or failed operations.
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
    table.text('dedupe_key').notNullable().unique();
    table.text('status').notNullable().defaultTo('queued').checkIn([
      'queued',
      'running',
      'completed',
      'failed',
    ]);
    table.text('error_message').nullable();
    table.timestamp('started_at').nullable();
    table.timestamp('finished_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['repository', 'source_pr_number']);
    table.index('status');
    table.index('original_comment_id');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX pr_split_operations_one_active_per_pr
    ON pr_split_operations (repository COLLATE NOCASE, source_pr_number)
    WHERE status IN ('queued', 'running')
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('pr_split_operations');
}
