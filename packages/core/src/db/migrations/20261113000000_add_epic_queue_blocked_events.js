// Records every time an issue of an epic execution becomes blocked, and every
// time that blocker is cleared, as a durable and ordered log. The queue writes a
// row in the same transaction as the per-issue state change, so each blocked
// transition is recorded exactly once whichever process (API, webhook handling,
// worker sweep) made it. `notified_at` is an outbox marker: the Inbox
// notification and realtime activity for a row are delivered after commit, and
// the recovery sweep delivers any row a crash left behind.
//
// Each issue row also records whether a skip treats the issue as satisfying the
// prerequisites of the issues that depend on it in a graph execution, and when a
// retry reserved the issue before reopening it on GitHub: competing skips and
// retries wait for that reservation, which lapses if the retrying process stops.
const EVENTS = 'epic_queue_blocked_events';
const ISSUES = 'epic_execution_queue_issues';

export async function up(knex) {
  if (!(await knex.schema.hasTable(EVENTS))) {
    await knex.schema.createTable(EVENTS, table => {
      table.increments('id');
      table.string('draft_id').notNullable().references('draft_id').inTable('task_drafts').onDelete('CASCADE');
      table.string('execution_id').notNullable();
      table.integer('issue_number').notNullable();
      // The occurrence: a requeued issue starts a new one at a new position.
      table.integer('position').notNullable();
      // blocked | resolved
      table.string('event', 16).notNullable();
      table.string('blocked_kind').notNullable();
      table.text('blocked_reason').notNullable();
      // For a resolved row: the blocked row it resolves, and how (cleared, replaced, retried, skipped, settled).
      table.integer('blocked_event_id').nullable();
      table.string('resolution', 16).nullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('notified_at').nullable();
      table.index(['draft_id', 'execution_id', 'id']);
      table.index(['execution_id', 'issue_number', 'position']);
    });
  }
  if ((await knex.schema.hasTable(ISSUES)) && !(await knex.schema.hasColumn(ISSUES, 'skip_satisfies_dependents'))) {
    await knex.schema.alterTable(ISSUES, table => table.boolean('skip_satisfies_dependents').notNullable().defaultTo(false));
  }
  if ((await knex.schema.hasTable(ISSUES)) && !(await knex.schema.hasColumn(ISSUES, 'retry_reserved_at'))) {
    await knex.schema.alterTable(ISSUES, table => table.bigInteger('retry_reserved_at').nullable());
  }
}

export async function down(knex) {
  if ((await knex.schema.hasTable(ISSUES)) && (await knex.schema.hasColumn(ISSUES, 'retry_reserved_at'))) {
    await knex.schema.alterTable(ISSUES, table => table.dropColumn('retry_reserved_at'));
  }
  if ((await knex.schema.hasTable(ISSUES)) && (await knex.schema.hasColumn(ISSUES, 'skip_satisfies_dependents'))) {
    await knex.schema.alterTable(ISSUES, table => table.dropColumn('skip_satisfies_dependents'));
  }
  await knex.schema.dropTableIfExists(EVENTS);
}
