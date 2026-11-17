import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { z } from 'zod';
import { isTimestampKey, normalizeResultTimestamps, normalizeTimestampValue } from '../mcp/resultTimestamps.js';
import { executeTool, type McpTool, type ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';

after(closeConnection);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

test('timestamp field names are recognized without catching durations, counts or free text', () => {
  for (const key of ['created_at', 'updated_at', 'merged_at', 'createdAt', 'updatedAt', 'nextRunAt', 'lastAt', 'lastInputDeliveredAt',
    'timestamp', 'state_timestamp', 'stateTimestamp', 'start_time', 'startTime', 'since', 'until', 'at']) {
    assert.equal(isTimestampKey(key), true, key);
  }
  for (const key of ['format', 'chat', 'elapsed_ms', 'elapsedMs', 'timeoutSeconds', 'runtime', 'sinceMinutes', 'state', 'cursor', 'status', 'repeat', 'timestamps']) {
    assert.equal(isTimestampKey(key), false, key);
  }
});

test('every timestamp shape the stores write becomes ISO 8601 UTC with Z', () => {
  assert.equal(normalizeTimestampValue('2026-11-02 10:12:51'), '2026-11-02T10:12:51.000Z', 'SQLite datetime text is UTC');
  assert.equal(normalizeTimestampValue('2026-11-02 10:12:51.25'), '2026-11-02T10:12:51.250Z');
  assert.equal(normalizeTimestampValue('2026-11-02T10:12:51'), '2026-11-02T10:12:51.000Z', 'a zone-less ISO string is UTC, never host-local');
  assert.equal(normalizeTimestampValue('2026-11-02T12:12:51+02:00'), '2026-11-02T10:12:51.000Z');
  assert.equal(normalizeTimestampValue('2026-11-02 12:12:51 +0200'), '2026-11-02T10:12:51.000Z');
  assert.equal(normalizeTimestampValue(1794092314931), '2026-11-07T22:58:34.931Z', 'epoch milliseconds');
  assert.equal(normalizeTimestampValue('1794092314931'), '2026-11-07T22:58:34.931Z');
  // Already UTC ISO strings are kept byte-for-byte.
  assert.equal(normalizeTimestampValue('2026-11-02T10:12:47Z'), '2026-11-02T10:12:47Z');
  assert.equal(normalizeTimestampValue('2026-11-02T10:07:28.179Z'), '2026-11-02T10:07:28.179Z');
  // Anything that is not an instant passes through.
  for (const value of [null, undefined, true, 0, 30, 1_794_092_314, 'never', '', '2026-11-02', 'abc 2026-11-02 10:12:51']) {
    assert.equal(normalizeTimestampValue(value), value);
  }
});

test('the recursive pass rewrites only timestamp fields, at any depth, and does not mutate its input', () => {
  const source = {
    // list_goals: one row mixed two formats.
    goals: [{ goal_id: 'g1', created_at: '2026-11-02T10:07:28.179Z', updated_at: '2026-11-02 10:12:51' }],
    // get_goal: the projection and the detail spelled the same checkpoint differently.
    goal: { checkpoint: { lastAt: '2026-11-02T10:12:47Z' }, createdAt: '2026-11-02T10:07:28.179Z' },
    progress: { checkpoint: { lastAt: '2026-11-02 10:12:47' }, elapsedSeconds: 1_800_000_000_000 },
    // Epoch milliseconds from Date.now() writers.
    events: [{ createdAt: 1794092314931, nextRunAt: 1794092314931, durationMs: 1794092314931 }],
    window: { since: '2026-11-01 00:00:00', until: '2026-11-02T00:00:00.000Z' },
    note: 'updated at 2026-11-02 10:12:51',
    cursor: '2026-11-02 10:12:51',
    nextOffset: null,
  };
  const before = JSON.stringify(source);
  const normalized = normalizeResultTimestamps(source);
  assert.equal(JSON.stringify(source), before, 'the input is not mutated');
  assert.deepEqual(normalized.goals[0], { goal_id: 'g1', created_at: '2026-11-02T10:07:28.179Z', updated_at: '2026-11-02T10:12:51.000Z' });
  assert.equal(normalized.goal.checkpoint.lastAt, '2026-11-02T10:12:47Z');
  assert.equal(normalized.progress.checkpoint.lastAt, '2026-11-02T10:12:47.000Z');
  assert.equal(new Date(normalized.goal.checkpoint.lastAt).getTime(), new Date(normalized.progress.checkpoint.lastAt).getTime());
  assert.equal(normalized.progress.elapsedSeconds, 1_800_000_000_000, 'non-timestamp numbers are untouched');
  assert.deepEqual(normalized.events[0], { createdAt: '2026-11-07T22:58:34.931Z', nextRunAt: '2026-11-07T22:58:34.931Z', durationMs: 1794092314931 });
  assert.deepEqual(normalized.window, { since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z' });
  assert.equal(normalized.note, source.note);
  assert.equal(normalized.cursor, source.cursor, 'opaque values keep their exact text');
  assert.equal(normalized.nextOffset, null);
});

test('executeTool reports every timestamp in a tool result as ISO 8601 UTC, whatever the tool returned', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    // A migrated database lets the access-log write succeed, so the run does not spin up error logging.
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    const stored = {
      plans: [{ draft_id: 'p1', created_at: '2026-11-02 10:07:28', updated_at: '2026-11-02 10:12:51' }],
      todos: [{ todo_id: 't1', created_at: '2026-11-02 10:07:28' }],
      members: [{ login: 'alice', addedAt: '2026-11-02 10:07:28' }],
      blockedEvents: [{ createdAt: 1794092314931 }],
      automation: { nextRunAt: 1794092314931, lastRunAt: null },
    };
    const tool: McpTool = { name: 'list_fixture_rows', description: 'fixture', scope: 'read', readOnly: true,
      schema: z.object({}).strict(), run: async () => ({ status: 200, data: structuredClone(stored) }) } as unknown as McpTool;
    const deps = {
      db,
      policy: { requireScope: () => undefined, requirePermission: () => undefined, repository: async () => undefined,
        config: { origin: 'https://instance.example', instanceId: 'fixture' } },
    } as unknown as ToolDeps;
    const principal = { user: { id: 'u1', username: 'alice' }, scopes: ['read'], grant: { id: 'g', repositories: [] }, authorization: { permissions: [] } } as unknown as McpPrincipal;
    const presented = await executeTool(tool, {}, principal, deps);
    const data = presented.data as typeof stored & Record<string, unknown>;
    const timestamps: unknown[] = [];
    const collect = (value: unknown, key = '') => {
      if (Array.isArray(value)) value.forEach(item => collect(item, key));
      else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) collect(item, name);
      else if (/(_at|At)$/.test(key) && value !== null) timestamps.push(value);
    };
    collect(data);
    assert.equal(timestamps.length, 6);
    for (const value of timestamps) assert.match(String(value), ISO_UTC);
    assert.equal(data.plans[0].updated_at, '2026-11-02T10:12:51.000Z');
    assert.equal(data.automation.lastRunAt, null);
    assert.equal(stored.plans[0].updated_at, '2026-11-02 10:12:51', 'the stored value is not rewritten');
  } finally {
    await db.destroy();
  }
});
