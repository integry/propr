// Gives every issue of an epic execution its own persisted state, replacing the
// queue's single cursor, dispatch claim (head_started_at) and free-text
// blocked_reason. Existing executions are migrated in place: issues before the
// cursor are done, the head keeps its claim and blocked reason, later issues are
// pending, and every child of an active parallel execution is dispatched (they
// were all labelled when the execution was requested). The old queue columns
// stay in place and are no longer read for progression; blocked_reason remains
// only for notes about the execution as a whole (an unstarted cancellation).
// The legacy reason of a parallel execution named only its latest blocked child;
// other children whose latest run stopped on a reported blocker are recovered
// from their persisted task history. Issues repeated in a legacy issue list (an
// issue requeued after it settled) collapse to one row each.
const TABLE = 'epic_execution_queue_issues';
const AGENT_BLOCKED = /^Issue #(\d+) stopped on a blocker reported by the agent;/;
const TERMINAL_PLAN_STATUSES = ['merged', 'closed'];
const agentBlockedReason = issueNumber =>
  `Issue #${issueNumber} stopped on a blocker reported by the agent; resolve the blocker and request processing again to continue this epic.`;
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

/**
 * One entry per issue, in queue order. A legacy append could requeue an issue that
 * had already settled (it compared only against issues from the cursor on), so an
 * issue may occur more than once; every occurrence but one is already done. The
 * outstanding occurrence (at or after the cursor) is kept, else the last one.
 */
export function normalizeLegacyIssues(queue) {
  const issues = parseIssues(queue.issues);
  const outstanding = index => queue.status !== 'completed' && (Boolean(queue.parallel) || index >= queue.cursor);
  const kept = new Map();
  issues.forEach((issueNumber, index) => {
    const previous = kept.get(issueNumber);
    if (previous === undefined || !outstanding(previous)) kept.set(issueNumber, index);
  });
  const indexes = [...kept.values()].sort((left, right) => left - right);
  const cursor = queue.status === 'completed' ? indexes.length : indexes.filter(index => index < queue.cursor).length;
  return { issues: indexes.map(index => issues[index]), cursor, changed: indexes.length !== issues.length };
}

function historyMetadata(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string' || !metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Mirrors the legacy check: the task's latest persisted state is a completed run that stopped on a reported blocker. */
async function latestRunBlocked(knex, taskId) {
  const latest = await knex('task_history').where({ task_id: taskId }).orderBy('timestamp', 'desc').orderBy('history_id', 'desc')
    .first('state', 'metadata');
  if (!latest || latest.state !== 'completed') return false;
  const metadata = historyMetadata(latest.metadata);
  const prResult = metadata.prResult && typeof metadata.prResult === 'object' ? metadata.prResult : {};
  return metadata.terminalReason === 'blocked' || prResult.terminalReason === 'blocked';
}

/**
 * Children of an active parallel execution that are not merged or closed and whose latest
 * run stopped on a reported blocker: the evidence the legacy clearing path consulted.
 */
export async function legacyParallelAgentBlockedIssues(knex, queue, issues) {
  if (!queue.parallel || queue.status !== 'active' || !issues.length) return new Set();
  if (!(await knex.schema.hasTable('task_history')) || !(await knex.schema.hasColumn('plan_issues', 'task_id'))) return new Set();
  const rows = await knex('plan_issues').where({ draft_id: queue.draft_id }).whereIn('issue_number', issues)
    .select('issue_number', 'status', 'task_id');
  const blocked = new Set();
  for (const issueNumber of issues) {
    const row = rows.find(candidate => candidate.issue_number === issueNumber);
    if (!row?.task_id || TERMINAL_PLAN_STATUSES.includes(row.status)) continue;
    if (await latestRunBlocked(knex, row.task_id)) blocked.add(issueNumber);
  }
  return blocked;
}

/** Per-issue rows for one legacy queue row; exported for the migration tests. */
export function legacyQueueIssueRows(queue, { agentBlocked = new Set() } = {}) {
  const { issues, cursor } = normalizeLegacyIssues(queue);
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
    if (completed || (!parallel && position < cursor)) return { ...row, state: 'done' };
    if (parallel) {
      const dispatched = { ...row, state: 'dispatched', dispatched_at: queue.created_at };
      if (blockedIssue === issueNumber) {
        return { ...dispatched, state: 'blocked', blocked_kind: 'agent_blocked', blocked_reason: reason, blocked_at: queue.updated_at };
      }
      // Blocked before the child the legacy reason names, which stays the latest explanation.
      return agentBlocked.has(issueNumber)
        ? { ...dispatched, state: 'blocked', blocked_kind: 'agent_blocked', blocked_reason: agentBlockedReason(issueNumber),
          blocked_at: Math.min(queue.created_at, queue.updated_at - 1) }
        : dispatched;
    }
    if (position !== cursor) return row;
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
    const normalized = normalizeLegacyIssues(queue);
    const agentBlocked = await legacyParallelAgentBlockedIssues(knex, queue, normalized.issues);
    const rows = legacyQueueIssueRows(queue, { agentBlocked });
    if (rows.length) await knex(TABLE).insert(rows);
    // Keep the legacy columns consistent with the rows, so a rollback restores a valid cursor.
    if (normalized.changed) {
      await knex('epic_execution_queues').where({ draft_id: queue.draft_id, execution_id: queue.execution_id })
        .update({ issues: JSON.stringify(normalized.issues), cursor: normalized.cursor });
    }
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
