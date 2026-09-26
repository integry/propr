import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';
import {
  at, buildDeps, buildPrincipal, configuredRepositories, createActivityDatabase, ids,
  insertGoal, insertHistory, insertNotification, insertNotifications, insertTask,
  mcpConfig, owner, repositories, type NotificationFixture,
} from './fixtures/mcpActivity.js';

const core = await import('@propr/core');
const coreMock = await mock.module('@propr/core', {
  namedExports: { ...core, loadMonitoredReposRaw: async () => configuredRepositories.current },
});
after(async () => { coreMock.restore(); await core.closeConnection(); });

const { createToolCatalog } = await import('../mcp/tools.js');
const { buildMcpServer } = await import('../mcp/server.js');
const { resolveWindow } = await import('../mcp/activityDigest.js');

function activityTool(deps: ToolDeps, name: string): McpTool {
  const tool = createToolCatalog(deps).find(candidate => candidate.name === name);
  assert.ok(tool, `${name} is registered in the catalog`);
  return tool;
}

/** Parse through the real schema so defaults and strictness are exercised. */
async function callTool(
  deps: ToolDeps, principal: McpPrincipal, name: string, args: Record<string, unknown> = {},
): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const tool = activityTool(deps, name);
  const result = await tool.run({ principal, args: tool.schema.parse(args) });
  assert.equal(result.status, 200);
  return result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test('recent activity bounds and orders both timestamp spellings before it limits', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);
  const [since, until] = ['2026-09-23T11:00:00.000Z', '2026-09-23T12:00:00.000Z'];

  // `knex.fn.now()` writes SQLite's offset-free spelling and producers write
  // canonical ISO-8601, so one window holds both. Raw text sorts every ISO row
  // above every same-day SQLite row, whatever hour each one names.
  for (const [taskId, timestamp] of [
    ['iso-before-09', '2026-09-23T09:00:00.000Z'],
    ['iso-before-08', '2026-09-23T08:00:00.000Z'],
    ['sqlite-inside', '2026-09-23 11:30:00'],
    ['sqlite-at-since', '2026-09-23 11:00:00'],
    ['iso-at-until', '2026-09-23T12:00:00.000Z'],
    ['sqlite-after', '2026-09-23 23:00:00'],
  ] as const) {
    await insertTask(db, { taskId, repository: 'acme/alpha', createdAt: timestamp, job: { title: `Work ${taskId}` } });
    await insertHistory(db, { taskId, state: 'completed', timestamp });
  }

  // One row of budget has to buy the newest event in the window, not the
  // oldest row a widened lexical bound happened to admit.
  const newest = await callTool(deps, principal, 'get_recent_activity', { since, until, limit: 1 });
  assert.deepEqual(ids(newest.events, event => event.reference.taskId), ['iso-at-until']);

  // Both bounds are inclusive, and both spellings order chronologically.
  const all = await callTool(deps, principal, 'get_recent_activity', { since, until });
  assert.deepEqual(ids(all.events, event => event.reference.taskId),
    ['iso-at-until', 'sqlite-inside', 'sqlite-at-since']);
});

test('pages over equal timestamps neither repeat nor skip an event', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);
  const [since, until] = ['2026-09-23T11:00:00.000Z', '2026-09-23T12:00:00.000Z'];
  const timestamp = '2026-09-23T11:30:00.000Z';

  // Push the terminal rows onto identifiers 9, 10 and 11: the numeric order
  // SQL limits by and the lexical order the merge ties by disagree there.
  await insertTask(db, { taskId: 'filler', repository: 'acme/alpha', createdAt: timestamp });
  for (let index = 0; index < 8; index++) {
    await insertHistory(db, { taskId: 'filler', state: 'pending', timestamp });
  }
  for (const taskId of ['tie-9', 'tie-10', 'tie-11']) {
    await insertTask(db, { taskId, repository: 'acme/alpha', createdAt: timestamp, job: { title: `Work ${taskId}` } });
    await insertHistory(db, { taskId, state: 'completed', timestamp });
  }
  const terminal = await db('task_history').where('state', 'completed').orderBy('history_id').select('history_id');
  assert.deepEqual(terminal.map(row => row.history_id), [9, 10, 11]);

  const paged: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const page = await callTool(deps, principal, 'get_recent_activity', { since, until, limit: 1, offset });
    paged.push(...ids(page.events, event => event.reference.taskId));
  }
  assert.deepEqual(paged, ['tie-11', 'tie-10', 'tie-9']);
});

test('a flood of filtered receipts cannot hide a blocker, and an exhausted scan says so', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);

  /** `count` routine receipts, each a second older than the one before it. */
  const noise = (prefix: string, repository: string, count: number, newest: number): NotificationFixture[] =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `${prefix}-${index}`, kind: 'task', severity: 'success',
      target: { type: 'task', repository, taskId: `${prefix}-${index}` },
      title: 'Implementation completed', body: 'Review the result.', occurredAt: at(newest + index * 1000),
    }));

  await insertNotification(db, {
    id: 'blocked-1', kind: 'task', severity: 'error',
    target: { type: 'task', repository: 'acme/alpha', taskId: 'broken-1' },
    title: 'Implementation failed', body: 'The agent stopped before finishing.', occurredAt: at(3_600_000),
  });
  // Newer than the blocker, and more of them than one page of receipts holds:
  // another repository's receipts and this repository's routine ones.
  await insertNotifications(db, [
    ...noise('other', 'acme/other', 400, 500_000),
    ...noise('routine', 'acme/alpha', 400, 100_000),
  ]);

  const digest = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(ids(digest.sections.blockers.items, blocker => blocker.reference.notificationId), ['blocked-1']);
  assert.equal(digest.sections.blockers.truncated, false);

  const timeline = await callTool(deps, principal, 'get_recent_activity', { sinceMinutes: 1440 });
  assert.deepEqual(ids(timeline.events, event => event.reference.notificationId), ['blocked-1']);
  assert.equal(timeline.scanTruncated, false);

  // Past the scan budget the blocker is out of reach, and both tools report
  // the incomplete scan instead of an empty, settled-looking answer.
  await insertNotifications(db, noise('flood', 'acme/alpha', 1800, 900_000));
  const flooded = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(flooded.sections.blockers.items, []);
  assert.equal(flooded.sections.blockers.truncated, true);
  const cut = await callTool(deps, principal, 'get_recent_activity', { sinceMinutes: 1440 });
  assert.deepEqual(cut.events, []);
  assert.equal(cut.scanTruncated, true);
});

test('recent activity resolves windows and rejects contradictory or over-long ones', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  assert.deepEqual(resolveWindow({}, now), { since: '2026-09-23T11:00:00.000Z', until: '2026-09-23T12:00:00.000Z' });
  assert.deepEqual(resolveWindow({ sinceMinutes: 30 }, now), { since: '2026-09-23T11:30:00.000Z', until: '2026-09-23T12:00:00.000Z' });
  assert.deepEqual(resolveWindow({ since: '2026-09-23T09:00:00.000Z', until: '2026-09-23T10:00:00.000Z' }, now),
    { since: '2026-09-23T09:00:00.000Z', until: '2026-09-23T10:00:00.000Z' });
  assert.deepEqual(resolveWindow({ sinceMinutes: 10080 }, now).since, '2026-09-16T12:00:00.000Z');
  assert.throws(() => resolveWindow({ sinceMinutes: 30, since: '2026-09-23T09:00:00.000Z' }, now), /exactly one/);
  assert.throws(() => resolveWindow({ since: '2026-09-23T12:00:00.000Z' }, now), /later than since/);
  assert.throws(() => resolveWindow({ since: '2026-09-23T13:00:00.000Z' }, now), /later than since/);
  assert.throws(() => resolveWindow({ since: '2026-09-15T11:00:00.000Z' }, now), /at most seven days/);
});

test('recent activity merges a bounded newest-first timeline and paginates it', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha', 'acme/beta');
  const deps = buildDeps(db, { forbidden: ['acme/beta'] });
  const principal = buildPrincipal(['acme/alpha', 'acme/beta']);

  await insertTask(db, { taskId: 'done-1', repository: 'acme/alpha', createdAt: at(4_000_000), issueNumber: 11, job: { title: 'Persist digest rows' } });
  await insertHistory(db, { taskId: 'done-1', state: 'completed', timestamp: at(600_000) });
  await insertTask(db, { taskId: 'broken-1', repository: 'acme/alpha', createdAt: at(4_000_000), job: { title: 'Broken work' } });
  await insertHistory(db, {
    taskId: 'broken-1', state: 'failed', timestamp: at(900_000), reason: 'Agent stopped',
    metadata: { error: { message: 'Agent exited before completing the requested edits' } },
  });
  await insertTask(db, { taskId: 'review-1', repository: 'acme/alpha', createdAt: at(4_000_000), prNumber: 42, taskType: 'review' });
  await insertHistory(db, { taskId: 'review-1', state: 'completed', timestamp: at(1_200_000) });
  await insertTask(db, { taskId: 'ultrafix-1', repository: 'acme/alpha', createdAt: at(4_000_000), prNumber: 43, taskType: 'pr-comment' });
  await insertHistory(db, {
    taskId: 'ultrafix-1', state: 'completed', timestamp: at(1_500_000),
    metadata: { ultrafixCycle: true, ultrafixStopReason: 'Max cycles exhausted' },
  });
  // Outside the grant and outside the window respectively.
  await insertTask(db, { taskId: 'done-beta', repository: 'acme/beta', createdAt: at(4_000_000) });
  await insertHistory(db, { taskId: 'done-beta', state: 'completed', timestamp: at(600_000) });
  await insertTask(db, { taskId: 'ancient', repository: 'acme/alpha', createdAt: at(40_000_000) });
  await insertHistory(db, { taskId: 'ancient', state: 'completed', timestamp: at(20_000_000) });

  await db('notification_pull_request_state').insert({ repository: 'acme/alpha', pr_number: 42, merged_at: at(300_000) });
  await db('task_drafts').insert({
    draft_id: 'plan-published', user_id: owner, repository: 'acme/alpha', name: 'Digest plan',
    status: 'executed', created_at: at(4_000_000), updated_at: at(1_800_000),
  });
  await db('plan_issues').insert({ draft_id: 'plan-published', repository: 'acme/alpha', issue_number: 11, task_id: 'done-1', pr_number: 42, status: 'merged' });
  await insertTask(db, { taskId: 'goal-task-done', repository: 'acme/alpha', createdAt: at(4_000_000), taskType: 'goal' });
  await insertGoal(db, {
    goal_id: '55555555-5555-4555-8555-555555555555', repository: 'acme/alpha', current_task_id: 'goal-task-done',
    title: 'Finished goal', result_state: 'completed', final_pr_number: 42,
    created_at: at(4_000_000), updated_at: at(2_100_000), completed_at: at(2_100_000),
  });

  const timeline = await callTool(deps, principal, 'get_recent_activity', { sinceMinutes: 60 });
  assert.deepEqual(timeline.repositories, ['acme/alpha']);
  assert.ok(Date.parse(timeline.window.since) < Date.parse(timeline.window.until));
  assert.deepEqual(ids(timeline.events, event => `${event.kind}:${event.outcome}`), [
    'pull_request:merged', 'task:completed', 'task:failed', 'review:posted',
    'ultrafix:Max cycles exhausted', 'plan:published', 'goal:completed',
  ]);
  assert.equal(timeline.nextOffset, null);
  assert.equal(timeline.scanTruncated, false);
  const [merged, completed, failed, review] = timeline.events;
  assert.equal(merged.summary, 'Pull request #42 merged');
  assert.deepEqual(merged.reference, { pullRequest: 42, taskId: 'done-1', planId: 'plan-published', issueNumber: 11 });
  assert.equal(merged.url, 'https://github.com/acme/alpha/pull/42');
  assert.equal(completed.summary, 'Task completed — Persist digest rows');
  assert.equal(failed.summary, 'Task failed — Broken work — Agent exited before completing the requested edits');
  assert.equal(review.summary, 'Review posted for PR #42 — Review pull request #42');
  assert.doesNotMatch(JSON.stringify(timeline), /done-beta|ancient/);

  const first = await callTool(deps, principal, 'get_recent_activity', { sinceMinutes: 60, limit: 3 });
  assert.equal(first.nextOffset, 3);
  const second = await callTool(deps, principal, 'get_recent_activity', { sinceMinutes: 60, limit: 3, offset: first.nextOffset });
  assert.equal(second.nextOffset, 6);
  const third = await callTool(deps, principal, 'get_recent_activity', { sinceMinutes: 60, limit: 3, offset: second.nextOffset });
  assert.equal(third.nextOffset, null);
  assert.deepEqual(ids([...first.events, ...second.events, ...third.events], event => event.summary),
    ids(timeline.events, event => event.summary));

  // A narrower window excludes what happened before it.
  const narrow = await callTool(deps, principal, 'get_recent_activity', { sinceMinutes: 10 });
  assert.deepEqual(ids(narrow.events, event => event.outcome), ['merged']);
  // Explicit bounds select an interior slice of the same data.
  const [since, until] = [at(1_300_000), at(1_000_000)];
  const bracketed = await callTool(deps, principal, 'get_recent_activity', { since, until });
  assert.deepEqual(ids(bracketed.events, event => event.kind), ['review']);
  assert.deepEqual(bracketed.window, { since, until });

  const tool = activityTool(deps, 'get_recent_activity');
  assert.throws(() => tool.schema.parse({ sinceMinutes: 30, since: at(600_000) }), /exactly one/);
  assert.throws(() => tool.schema.parse({ unexpected: true }));
  await assert.rejects(tool.run({ principal, args: tool.schema.parse({ since: at(8 * 24 * 3_600_000) }) }), /at most seven days/);
});

test('a merged pull request with several plan relations points at the newest one', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);

  await db('notification_pull_request_state').insert({ repository: 'acme/alpha', pr_number: 42, merged_at: at(300_000) });
  for (const [draft, issue, task] of [['plan-old', 10, 'task-old'], ['plan-middle', 11, 'task-middle'], ['plan-new', 12, 'task-new']] as const) {
    await db('task_drafts').insert({ draft_id: draft, user_id: owner, repository: 'acme/alpha', name: draft,
      status: 'draft', created_at: at(4_000_000), updated_at: at(4_000_000) });
    await db('plan_issues').insert({ draft_id: draft, repository: 'acme/alpha', issue_number: issue, task_id: task, pr_number: 42, status: 'merged' });
  }

  const timeline = await callTool(deps, principal, 'get_recent_activity');
  assert.deepEqual(timeline.events.map((event: Record<string, unknown>) => event.reference),
    [{ pullRequest: 42, taskId: 'task-new', planId: 'plan-new', issueNumber: 12 }]);
});

test('recent activity records opened pull requests and blocking notifications', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);

  await insertNotification(db, {
    id: 'pr-open', kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'acme/alpha', prNumber: 77 },
    title: 'PR #77 ready for review', body: 'PR #77 is ready for review.',
    metadata: { completedImplementationTaskId: 'impl-1' }, occurredAt: at(300_000),
  });
  await insertNotification(db, {
    id: 'routine-task', kind: 'task', severity: 'success',
    target: { type: 'task', repository: 'acme/alpha', taskId: 'impl-1' },
    title: 'Implementation completed', body: 'Review the result.', occurredAt: at(400_000),
  });
  await insertNotification(db, {
    id: 'index-error', kind: 'indexing', severity: 'error',
    target: { type: 'indexing', repository: 'acme/alpha' },
    title: 'Repository indexing failed', body: 'Indexing stopped before completion.', occurredAt: at(500_000),
  });

  const timeline = await callTool(deps, principal, 'get_recent_activity');
  assert.deepEqual(ids(timeline.events, event => `${event.kind}:${event.outcome}`), ['pull_request:opened', 'notification:error']);
  assert.equal(timeline.events[0].url, 'https://github.com/acme/alpha/pull/77');
  assert.equal(timeline.events[0].reference.pullRequest, 77);

  const routine = await callTool(deps, principal, 'get_recent_activity', { includeRoutine: true });
  assert.deepEqual(ids(routine.events, event => event.kind), ['pull_request', 'notification', 'notification']);
});

test('a dismissed Inbox card stays in the historical timeline but not among current blockers', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha', 'acme/beta');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);

  await insertNotification(db, {
    id: 'pr-open', kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'acme/alpha', prNumber: 77 },
    title: 'PR #77 ready for review', body: 'PR #77 is ready for review.', occurredAt: at(300_000),
  });
  await insertNotification(db, {
    id: 'index-error', kind: 'indexing', severity: 'error',
    target: { type: 'indexing', repository: 'acme/alpha' },
    title: 'Repository indexing failed', body: 'Indexing stopped before completion.', occurredAt: at(500_000),
  });
  // Dismissed, but outside the grant: dismissal must not widen the repository scope.
  await insertNotification(db, {
    id: 'beta-open', kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'acme/beta', prNumber: 5 },
    title: 'PR #5 ready for review', body: 'PR #5 is ready for review.', occurredAt: at(200_000),
  });
  // Another user's dismissed receipt for the same event must not leak either.
  await db('notification_user_states').insert({ event_id: 'index-error', user_id: 'someone-else', inbox_enabled: true,
    push_enabled: false, created_at: at(500_000), dismissed_at: at(100_000) });
  await db('notification_user_states').where({ user_id: owner }).update({ dismissed_at: at(100_000) });

  const timeline = await callTool(deps, principal, 'get_recent_activity');
  assert.deepEqual(ids(timeline.events, event => `${event.kind}:${event.outcome}`), ['pull_request:opened', 'notification:error']);
  assert.equal(timeline.events[0].reference.pullRequest, 77);
  assert.equal(timeline.scanTruncated, false);

  const current = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(current.sections.blockers.items, []);
});

test('both activity resources resolve through the registered MCP server', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);
  const catalog = createToolCatalog(deps);

  await insertTask(db, { taskId: 'live-1', repository: 'acme/alpha', createdAt: at(600_000), job: { title: 'Live work' } });
  await insertHistory(db, { taskId: 'live-1', state: 'claude_execution', timestamp: at(300_000) });

  const app = express();
  app.use(express.json());
  app.all('/api/mcp', async (req, res) => {
    const handler = createMcpHandler(() => buildMcpServer(principal, deps, catalog), { legacy: 'stateless' });
    try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
  const client = new Client({ name: 'activity-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url) as never);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'get_current_activity'));
    assert.ok(tools.tools.some(tool => tool.name === 'get_recent_activity'));
    assert.ok((await client.listPrompts()).prompts.some(prompt => prompt.name === 'operator_briefing'));

    const resources = await client.listResources();
    const uris = resources.resources.map(resource => resource.uri);
    assert.ok(uris.includes(`propr://instances/${mcpConfig.instanceId}/activity`));
    assert.ok(uris.includes(`propr://instances/${mcpConfig.instanceId}/activity/recent`));

    const current = await client.readResource({ uri: `propr://instances/${mcpConfig.instanceId}/activity` });
    assert.equal(current.contents.length, 1);
    const currentBody = JSON.parse(String(current.contents[0].text));
    assert.deepEqual(currentBody.data.repositories, ['acme/alpha']);
    assert.deepEqual(ids(currentBody.data.sections.runningTasks.items, task => task.taskId), ['live-1']);

    const recent = await client.readResource({ uri: `propr://instances/${mcpConfig.instanceId}/activity/recent` });
    assert.equal(recent.contents.length, 1);
    const recentBody = JSON.parse(String(recent.contents[0].text));
    assert.ok(Date.parse(recentBody.data.window.since) > 0);
    assert.deepEqual(recentBody.data.events, []);
    assert.equal(recentBody.data.nextOffset, null);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
