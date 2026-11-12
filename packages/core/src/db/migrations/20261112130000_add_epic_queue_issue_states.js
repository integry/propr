// Gives every issue of an epic execution its own persisted state, replacing the
// queue's single cursor, dispatch claim (head_started_at) and free-text
// blocked_reason. Existing executions are migrated in place: issues before the
// cursor are done, the head keeps its claim and blocked reason, later issues are
// pending, and every child of an active parallel execution is dispatched (they
// were all labelled when the execution was requested). The old queue columns
// stay in place and are no longer read for progression; blocked_reason remains
// only for notes about the execution as a whole (an unstarted cancellation).
const TABLE = 'epic_execution_queue_issues';
const AGENT_BLOCKED = /^Issue #(\d+) stopped on a blocker reported by the agent;/;
const UNSTARTED = 'Initial queue head never started; implementation may be requested again.';

/** Mirrors the string patterns the queue used to tell its blocked reasons apart. */
export function classifyLegacyBlockedReason(reason) {
  if (AGENT_BLOCKED.test(reason)) return 'agent_blocked';
  if (reason.startsWith('Waiting for human merge:')) return 'awaiting_human_merge';
  if (reason.startsWith('Could not start issue #')) return 'dispatch_failed';
  if (reason.startsWith('Could not release issue #')) return 'label_handoff';
  if (/^Selected issue #\d+ is missing from this plan\./.test(reason)) return 'missing_from_plan';
  if (/^Issue #\d+ is \S+; this epic advances only after it is merged\./.test(reason)) return 'closed_unmerged';
  if (reason.startsWith('Preparing queued issue model') || reason.startsWith('Initial epic dispatch did not establish')) return 'setup_not_ready';
  return 'dispatch_failed';
}

function parseIssues(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(issue => Number.isInteger(issue)) : [];
  } catch {
    return [];
  }
}

/** Per-issue rows for one legacy queue row; exported for the migration tests. */
export function legacyQueueIssueRows(queue) {
  const issues = parseIssues(queue.issues);
  const completed = queue.status === 'completed';
  const parallel = Boolean(queue.parallel);
  const reason = queue.blocked_reason ?? null;
  const executionNote = queue.status === 'cancelled' && reason === UNSTARTED;
  const blockedIssue = parallel && reason ? Number(AGENT_BLOCKED.exec(reason)?.[1] ?? NaN) : null;
  return issues.map((issueNumber, position) => {
    const row = {
      draft_id: queue.draft_id, execution_id: queue.execution_id, issue_number: issueNumber, position,
      state: 'pending', dispatched_at: null, blocked_kind: null, blocked_reason: null, blocked_at: null,
      created_at: queue.created_at, updated_at: queue.updated_at,
    };
    if (completed || (!parallel && position < queue.cursor)) return { ...row, state: 'done' };
    if (parallel) {
      const dispatched = { ...row, state: 'dispatched', dispatched_at: queue.created_at };
      return blockedIssue === issueNumber
        ? { ...dispatched, state: 'blocked', blocked_kind: 'agent_blocked', blocked_reason: reason, blocked_at: queue.updated_at }
        : dispatched;
    }
    if (position !== queue.cursor) return row;
    const head = queue.head_started_at === null || queue.head_started_at === undefined
      ? row : { ...row, state: 'dispatched', dispatched_at: queue.head_started_at };
    if (!reason || executionNote) return head;
    return { ...head, state: 'blocked', blocked_kind: classifyLegacyBlockedReason(reason), blocked_reason: reason, blocked_at: queue.updated_at };
  });
}

export async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, table => {
      table.string('draft_id').notNullable().references('draft_id').inTable('task_drafts').onDelete('CASCADE');
      table.string('execution_id').notNullable();
      table.integer('issue_number').notNullable();
      table.integer('position').notNullable();
      // pending | dispatched | done | blocked | skipped
      table.string('state').notNullable().defaultTo('pending');
      // The issue's own dispatch claim; kept while it is blocked so the retry window still applies.
      table.bigInteger('dispatched_at').nullable();
      table.string('blocked_kind').nullable();
      table.text('blocked_reason').nullable();
      table.bigInteger('blocked_at').nullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.primary(['execution_id', 'issue_number']);
      table.index(['draft_id', 'execution_id']);
    });
  }
  // A queue without a blocked_reason or claim column predates nothing we rely on; select what exists.
  const queues = await knex('epic_execution_queues').select('*');
  for (const queue of queues) {
    const existing = await knex(TABLE).where({ execution_id: queue.execution_id }).first('issue_number');
    if (existing) continue;
    const rows = legacyQueueIssueRows(queue);
    if (rows.length) await knex(TABLE).insert(rows);
    // The head's reason now lives on its row; only an execution-wide note stays on the queue.
    if (queue.blocked_reason && !(queue.status === 'cancelled' && queue.blocked_reason === UNSTARTED)) {
      await knex('epic_execution_queues').where({ draft_id: queue.draft_id, execution_id: queue.execution_id })
        .update({ blocked_reason: null });
    }
  }
}

export async function down(knex) {
  // Restore the single cursor, claim and reason from the per-issue rows before dropping them.
  if (!(await knex.schema.hasTable(TABLE))) return;
  const queues = await knex('epic_execution_queues').select('*');
  for (const queue of queues) {
    const rows = await knex(TABLE).where({ execution_id: queue.execution_id }).orderBy('position');
    if (!rows.length) continue;
    const open = rows.findIndex(row => row.state !== 'done' && row.state !== 'skipped');
    const parallel = Boolean(queue.parallel);
    // A parallel execution kept its cursor at zero until it completed.
    const cursor = queue.status === 'completed' ? rows.length : parallel ? 0 : open === -1 ? rows.length : open;
    const head = parallel ? undefined : rows[cursor];
    const blocked = rows.find(row => row.state === 'blocked');
    await knex('epic_execution_queues').where({ draft_id: queue.draft_id, execution_id: queue.execution_id }).update({
      cursor, head_started_at: head?.dispatched_at ?? null,
      blocked_reason: queue.blocked_reason ?? (head?.state === 'blocked' ? head.blocked_reason : blocked?.blocked_reason ?? null),
    });
  }
  await knex.schema.dropTableIfExists(TABLE);
}
