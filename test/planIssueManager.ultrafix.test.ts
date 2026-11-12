import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

type Row = Record<string, unknown>;

const rows = new Map<string, Row>();
let nextId = 1;
/** Which builder operation the database rejects, mirroring an unavailable connection. */
let failing: 'first' | 'update' | undefined;
/** Runs while a lookup awaits the database, before it resolves. */
let duringLookup: (() => Promise<void>) | undefined;

function makeKey(where: Record<string, unknown>): string {
  if ('id' in where) return `id:${where.id}`;
  if ('draft_id' in where && 'issue_number' in where) return `${where.draft_id}:${where.issue_number}`;
  return [...rows].find(([key, row]) => key.startsWith('id:') && Object.entries(where).every(([field, value]) => row[field] === value))?.[0] ?? 'missing';
}

function createBuilder(tableName: string) {
  let whereClause: Record<string, unknown> = {};

  return {
    where(clause: Record<string, unknown>) {
      whereClause = clause;
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      return this;
    },
    offset() {
      return this;
    },
    count() {
      return { first: async () => ({ count: rows.size }) };
    },
    select() {
      return this;
    },
    async insert(data: Row) {
      assert.strictEqual(tableName, 'plan_issues');
      const id = nextId++;
      rows.set(`id:${id}`, { id, ...data });
      rows.set(`${data.draft_id}:${data.issue_number}`, { id, ...data });
      return [id];
    },
    async first() {
      if (failing === 'first') throw new Error('database unavailable');
      await duringLookup?.();
      return rows.get(makeKey(whereClause)) ?? null;
    },
    async update(data: Row) {
      if (failing === 'update') throw new Error('database unavailable');
      const row = rows.get(makeKey(whereClause));
      if (!row) return 0;
      const next = { ...row, ...data };
      rows.set(`id:${next.id}`, next);
      rows.set(`${next.draft_id}:${next.issue_number}`, next);
      return 1;
    },
    async delete() {
      const row = rows.get(makeKey(whereClause));
      if (!row) return 0;
      rows.delete(`id:${row.id}`); rows.delete(`${row.draft_id}:${row.issue_number}`);
      return 1;
    },
    async increment() {
      return this;
    }
  };
}

const mockDb = Object.assign(
  (tableName: string) => createBuilder(tableName),
  { fn: { now: () => 'now' } }
);

await mock.module('../packages/core/src/db/connection.js', {
  namedExports: {
    db: mockDb,
  },
});

await mock.module('../packages/core/src/utils/logger.js', {
  defaultExport: {
    info: mock.fn(),
    error: mock.fn(),
    warn: mock.fn(),
  },
});

const mockCheckAndUpdateDraftStatus = mock.fn(async () => {});
// The fake database only models plan_issues; journal appends have their own suite.
await mock.module('../packages/core/src/services/repositoryEventJournal.js', {
  namedExports: { appendRepositoryEvent: mock.fn(async () => ({ status: 'duplicate' })) },
});

await mock.module('../packages/core/src/services/taskPlanningService.js', {
  namedExports: {
    checkAndUpdateDraftStatus: mockCheckAndUpdateDraftStatus,
  },
});

await mock.module('../packages/core/src/config/planIssueDefaults.js', {
  namedExports: {
    resolvePlanIssueDefaultSelection: mock.fn(async (selection: { agent_alias?: string | null; model_name?: string | null }) => ({
      agent_alias: selection.agent_alias ?? null,
      model_name: selection.model_name ?? null,
    })),
  },
});

const queueNotifications = mock.fn(async (_draftId: string, _issueNumber: number, _status: string) => {});
await mock.module('../packages/core/src/services/taskPlanning/epicExecutionQueue.js', {
  namedExports: { onPlanIssueStatusChanged: queueNotifications },
});

const activity = mock.fn(async (_payload: unknown) => true);
await mock.module('../packages/core/src/utils/eventPublisher.js', {
  namedExports: { getEventPublisher: () => ({ publishActivity: activity }) },
});

const { createPlanIssue, findPlanIssueByRepoAndNumber, updatePlanIssue, updatePlanIssueStatus, updatePlanIssueByPR, deletePlanIssue, PlanIssueStatus } = await import('../packages/core/src/config/planIssueManager.js');

describe('planIssueManager ultrafix persistence', () => {
  beforeEach(() => {
    activity.mock.resetCalls();
    rows.clear();
    nextId = 1;
    failing = undefined;
    duringLookup = undefined;
    queueNotifications.mock.resetCalls();
    mockCheckAndUpdateDraftStatus.mock.resetCalls();
  });

  test('updatePlanIssueStatus abandons the update and queue notification when ownership is lost during its lookup', async () => {
    await createPlanIssue({ draft_id: 'draft-1', repository: 'owner/repo', issue_number: 101 });
    let owner = 'request-a';
    // Renewed work (request B) is admitted while the writer awaits its initial plan-issue lookup.
    duringLookup = async () => { duringLookup = undefined; owner = 'request-b'; };
    const persisted = await updatePlanIssueStatus('owner/repo', 101, PlanIssueStatus.MERGED, { stillApplies: async () => owner === 'request-a' });
    assert.strictEqual(persisted, false);
    assert.strictEqual(rows.get('draft-1:101')?.status, PlanIssueStatus.PENDING, 'the renewed work is not marked merged');
    assert.strictEqual(queueNotifications.mock.callCount(), 0, 'the epic queue is not told to release a successor');
    assert.strictEqual(mockCheckAndUpdateDraftStatus.mock.callCount(), 0);
  });

  test('updatePlanIssueStatus updates and notifies when its ownership guard still holds', async () => {
    await createPlanIssue({ draft_id: 'draft-1', repository: 'owner/repo', issue_number: 101 });
    let checks = 0;
    duringLookup = async () => { duringLookup = undefined; assert.strictEqual(checks, 0, 'the guard runs after the lookup'); };
    const persisted = await updatePlanIssueStatus('owner/repo', 101, PlanIssueStatus.MERGED, { stillApplies: async () => { checks += 1; return true; } });
    assert.strictEqual(persisted, true);
    assert.strictEqual(checks, 1);
    assert.strictEqual(rows.get('draft-1:101')?.status, PlanIssueStatus.MERGED);
    assert.deepEqual(queueNotifications.mock.calls.map(call => call.arguments), [['draft-1', 101, PlanIssueStatus.MERGED]]);
  });

  test('updatePlanIssueStatus reports whether the status persisted, without throwing', async () => {
    await createPlanIssue({ draft_id: 'draft-1', repository: 'owner/repo', issue_number: 101 });
    failing = 'update';
    assert.strictEqual(await updatePlanIssueStatus('owner/repo', 101, PlanIssueStatus.MERGED), false);
    failing = undefined;
    assert.strictEqual(await updatePlanIssueStatus('owner/repo', 101, PlanIssueStatus.MERGED), true);
  });

  test('updatePlanIssueStatus still reports a persisted status when the follow-on draft sync fails', async () => {
    await createPlanIssue({ draft_id: 'draft-1', repository: 'owner/repo', issue_number: 101 });
    mockCheckAndUpdateDraftStatus.mock.mockImplementationOnce(async () => { throw new Error('draft sync failed'); });
    assert.strictEqual(await updatePlanIssueStatus('owner/repo', 101, PlanIssueStatus.MERGED), true);
  });

  test('a failed plan-issue lookup resolves null unless the caller asks for the failure', async () => {
    failing = 'first';
    assert.strictEqual(await findPlanIssueByRepoAndNumber('owner/repo', 101), null);
    await assert.rejects(findPlanIssueByRepoAndNumber('owner/repo', 101, { throwOnError: true }), /database unavailable/);
  });

  test('publishes every status entry point even when the aggregate draft status is unchanged', async () => {
    await createPlanIssue({ draft_id: 'draft-1', repository: 'owner/repo', issue_number: 101 });
    await updatePlanIssue('draft-1', 101, { pr_number: 42, status: PlanIssueStatus.UNDER_REVIEW });
    await updatePlanIssueStatus('owner/repo', 101, PlanIssueStatus.MERGED);
    await updatePlanIssueByPR('owner/repo', 42, { status: PlanIssueStatus.CLOSED });
    await deletePlanIssue('draft-1', 101);
    assert.deepEqual(activity.mock.calls.map(call => (call.arguments[0] as { change: string }).change),
      ['created', 'blocked', 'completed', 'cancelled', 'cancelled']);
  });

  test('createPlanIssue persists ultrafix fields', async () => {
    const created = await createPlanIssue({
      draft_id: 'draft-1',
      repository: 'owner/repo',
      issue_number: 101,
      run_ultrafix: true,
      ultrafix_goal: 8,
      ultrafix_max_cycles: 4,
    });

    assert.strictEqual(created?.run_ultrafix, true);
    assert.strictEqual(created?.ultrafix_goal, 8);
    assert.strictEqual(created?.ultrafix_max_cycles, 4);
  });

  test('updatePlanIssue updates ultrafix fields', async () => {
    await createPlanIssue({
      draft_id: 'draft-1',
      repository: 'owner/repo',
      issue_number: 101,
    });

    const updated = await updatePlanIssue('draft-1', 101, {
      run_ultrafix: false,
      ultrafix_goal: null,
      ultrafix_max_cycles: null,
    });

    assert.strictEqual(updated?.run_ultrafix, false);
    assert.strictEqual(updated?.ultrafix_goal, null);
    assert.strictEqual(updated?.ultrafix_max_cycles, null);
  });
});
