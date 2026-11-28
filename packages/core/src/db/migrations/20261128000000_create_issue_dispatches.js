// One durable row per issue for the dispatch of its issue job (the matrix
// dispatcher). Each dispatch gets its own BullMQ job ID; deduplication of
// requests for the same issue happens on this row, never by replacing or
// removing a BullMQ job. The row's state follows the dispatch's job:
// queued → (deferred → queued)* → processing → (queued → …) → completed | failed.
// `started_at` records that an attempt of this dispatch entered its processor,
// which is what a refusal report may rely on.
//
// `plan_issues.issue_dispatch_id` points a plan issue at the dispatch that
// runs it, so a dispatch's outcome changes only that plan issue, and only
// while it still points at that dispatch.
const TABLE = 'issue_dispatches';
const PLAN_ISSUES = 'plan_issues';
const LINK = 'issue_dispatch_id';

export async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, table => {
      table.string('repository').notNullable();
      table.integer('issue_number').notNullable();
      table.string('dispatch_id', 64).notNullable();
      table.string('job_id').notNullable();
      table.string('state', 16).notNullable();
      // Epoch milliseconds throughout.
      table.bigInteger('started_at').nullable();
      table.bigInteger('retry_at').nullable();
      table.text('details').nullable();
      table.text('error').nullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.primary(['repository', 'issue_number']);
      table.unique(['dispatch_id'], { indexName: 'issue_dispatches_dispatch_id_unique' });
    });
  }
  if ((await knex.schema.hasTable(PLAN_ISSUES)) && !(await knex.schema.hasColumn(PLAN_ISSUES, LINK))) {
    await knex.schema.alterTable(PLAN_ISSUES, table => {
      table.string(LINK, 64).nullable();
      table.index([LINK], 'plan_issues_issue_dispatch_id_index');
    });
  }
}

export async function down(knex) {
  if ((await knex.schema.hasTable(PLAN_ISSUES)) && (await knex.schema.hasColumn(PLAN_ISSUES, LINK))) {
    await knex.schema.alterTable(PLAN_ISSUES, table => {
      table.dropIndex([LINK], 'plan_issues_issue_dispatch_id_index');
      table.dropColumn(LINK);
    });
  }
  await knex.schema.dropTableIfExists(TABLE);
}
