/**
 * `GET /api/config/agent-tank/history` query parsing and handler wiring.
 *
 * The usage charts send `?since=&until=` as epoch milliseconds or ISO 8601 and
 * an optional comma-separated `?agent=` list. A range the store cannot answer -
 * unreadable or inverted - must be rejected with 400 instead of silently
 * returning an empty chart, and a range reaching past retention is clamped.
 */

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TANK_HISTORY_RETENTION_DAYS } from '@propr/shared';

process.env.NODE_ENV = 'test';

const { hasAgentTankStatuses, hasUsableAgentTankStatuses, parseAgentTankStatusMap } =
  await import('../../core/src/services/agentTankTypes.js');

const historyCalls: unknown[] = [];
let historyFailure: Error | undefined;

await mock.module('@propr/core', {
  namedExports: {
    loadAgentTankSettings: async () => ({ mode: 'bundled', enabled: true, url: 'http://0.0.0.0:3456' }),
    saveAgentTankSettings: async () => {},
    refreshBundledStatuses: async () => undefined,
    getAgentTankStatuses: async () => undefined,
    canRunBundledAgentTank: async () => false,
    observeAgentTankUsageSnapshot: async () => {},
    getEventPublisher: () => ({ publishUsageUpdate: async () => {} }),
    hasAgentTankStatuses,
    hasUsableAgentTankStatuses,
    parseAgentTankStatusMap,
    readAgentTankUsageHistory: async (query: unknown) => {
      historyCalls.push(query);
      if (historyFailure) throw historyFailure;
      return { enabled: true, source: 'propr', agents: [] };
    },
  },
});

const { createAgentTankRoutes, parseHistoryQuery } = await import('../routes/configRoutesAgentTank.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function responseSpy() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
  };
}

test('an empty query covers the last 24 hours with no filters', () => {
  assert.deepEqual(parseHistoryQuery({}, NOW), { since: NOW - DAY_MS, until: NOW });
});

test('empty-string bounds fall back to the defaults', () => {
  assert.deepEqual(parseHistoryQuery({ since: '', until: '' }, NOW), { since: NOW - DAY_MS, until: NOW });
});

test('since defaults to one day before an explicit until', () => {
  const until = NOW - 2 * DAY_MS;
  assert.deepEqual(parseHistoryQuery({ until: String(until) }, NOW), { since: until - DAY_MS, until });
});

test('accepts epoch milliseconds and ISO 8601 interchangeably', () => {
  const since = NOW - 3 * 60 * 60 * 1000;
  assert.deepEqual(
    parseHistoryQuery({ since: String(since), until: new Date(NOW).toISOString() }, NOW),
    { since, until: NOW },
  );
  assert.deepEqual(
    parseHistoryQuery({ since: new Date(since).toISOString(), until: String(NOW) }, NOW),
    { since, until: NOW },
  );
});

test('unreadable timestamps are an error', () => {
  for (const query of [{ since: 'yesterday' }, { until: 'not-a-date' }, { since: ['1', '2'] }, { until: 5 }]) {
    const result = parseHistoryQuery(query, NOW);
    assert.ok('error' in result, `expected an error for ${JSON.stringify(query)}`);
    assert.match(result.error, /epoch milliseconds or ISO 8601/);
  }
});

test('since after until is an error', () => {
  const result = parseHistoryQuery({ since: String(NOW), until: String(NOW - 1) }, NOW);
  assert.deepEqual(result, { error: 'since must not be after until' });
});

test('since equal to until is a valid single-instant range', () => {
  assert.deepEqual(parseHistoryQuery({ since: String(NOW), until: String(NOW) }, NOW), { since: NOW, until: NOW });
});

test('a range reaching past retention is clamped to what history keeps', () => {
  const result = parseHistoryQuery({ since: '0' }, NOW);
  assert.deepEqual(result, { since: NOW - AGENT_TANK_HISTORY_RETENTION_DAYS * DAY_MS, until: NOW });
});

test('agent lists are split, trimmed and stripped of empty entries', () => {
  const result = parseHistoryQuery({ agent: ' claude, ,codex,antigravity ,' }, NOW);
  assert.deepEqual(result, { since: NOW - DAY_MS, until: NOW, agents: ['claude', 'codex', 'antigravity'] });
});

test('an agent list with no names and an empty metric add no filters', () => {
  assert.deepEqual(parseHistoryQuery({ agent: ' , ', metric: '' }, NOW), { since: NOW - DAY_MS, until: NOW });
});

test('a metric filter is passed through', () => {
  const result = parseHistoryQuery({ agent: 'antigravity', metric: 'model:Gemini 4 Argon Weekly Limit' }, NOW);
  assert.deepEqual(result, {
    since: NOW - DAY_MS,
    until: NOW,
    agents: ['antigravity'],
    metric: 'model:Gemini 4 Argon Weekly Limit',
  });
});

test('the handler answers 400 for an invalid range without reading history', async () => {
  historyCalls.length = 0;
  const res = responseSpy();
  await createAgentTankRoutes().getAgentTankHistory(
    { query: { since: 'later', until: 'earlier' } } as never,
    res as never,
  );
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body?.error), /epoch milliseconds or ISO 8601/);
  assert.equal(historyCalls.length, 0);
});

test('the handler forwards the parsed query and returns the history answer', async () => {
  historyCalls.length = 0;
  const res = responseSpy();
  const since = Date.now() - 60 * 60 * 1000;
  const until = Date.now();
  await createAgentTankRoutes().getAgentTankHistory(
    { query: { since: String(since), until: String(until), agent: 'claude' } } as never,
    res as never,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { enabled: true, source: 'propr', agents: [] });
  assert.deepEqual(historyCalls, [{ since, until, agents: ['claude'] }]);
});

test('the handler answers 500 when history cannot be read', async () => {
  historyFailure = new Error('database is locked');
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = responseSpy();
    await createAgentTankRoutes().getAgentTankHistory({ query: {} } as never, res as never);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to read Agent Tank usage history' });
  } finally {
    console.error = originalError;
    historyFailure = undefined;
  }
});
