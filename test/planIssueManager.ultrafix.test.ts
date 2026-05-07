import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

type Row = Record<string, unknown>;

const rows = new Map<string, Row>();
let nextId = 1;

function makeKey(where: Record<string, unknown>): string {
  if ('id' in where) return `id:${where.id}`;
  return `${where.draft_id}:${where.issue_number}`;
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
      return rows.get(makeKey(whereClause)) ?? null;
    },
    async update(data: Row) {
      const row = rows.get(makeKey(whereClause));
      if (!row) return 0;
      const next = { ...row, ...data };
      rows.set(`id:${next.id}`, next);
      rows.set(`${next.draft_id}:${next.issue_number}`, next);
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
  },
});

const mockCheckAndUpdateDraftStatus = mock.fn(async () => {});
await mock.module('../packages/core/src/services/taskPlanningService.js', {
  namedExports: {
    checkAndUpdateDraftStatus: mockCheckAndUpdateDraftStatus,
  },
});

const { createPlanIssue, updatePlanIssue } = await import('../packages/core/src/config/planIssueManager.js');

describe('planIssueManager ultrafix persistence', () => {
  beforeEach(() => {
    rows.clear();
    nextId = 1;
    mockCheckAndUpdateDraftStatus.mock.resetCalls();
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
