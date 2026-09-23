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
  assertSectionsConsistent, at, buildDeps, buildPrincipal, configuredRepositories,
  createActivityDatabase, ids, insertGoal, insertHistory, insertNotification, insertNotifications,
  insertTask, mcpConfig, owner, repositories, type NotificationFixture,
} from './fixtures/mcpActivity.js';

const core = await import('@propr/core');
const coreMock = await mock.module('@propr/core', {
  namedExports: { ...core, loadMonitoredReposRaw: async () => configuredRepositories.current },
});
after(async () => { coreMock.restore(); await core.closeConnection(); });

const { createToolCatalog } = await import('../mcp/tools.js');
const { buildMcpServer } = await import('../mcp/server.js');
const { isOperatorRelevant, resolveWindow } = await import('../mcp/activityDigest.js');

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

test('current activity fans out across the grant, skips a forbidden repository and classifies task phases', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha', 'acme/beta', 'acme/gamma', ['acme/retired', false]);
  const deps = buildDeps(db, { forbidden: ['acme/beta'] });
  // The grant covers beta (403 from GitHub) and retired (no longer enabled);
  // gamma is configured and enabled but outside the grant entirely.
  const principal = buildPrincipal(['acme/alpha', 'acme/beta', 'acme/retired']);

  for (const [taskId, repository, state] of [
    ['run-alpha', 'acme/alpha', 'codex_execution'],
    ['queued-alpha', 'acme/alpha', 'queued'],
    ['failed-alpha', 'acme/alpha', 'failed'],
    ['done-alpha', 'acme/alpha', 'completed'],
    ['run-beta', 'acme/beta', 'claude_execution'],
    ['run-gamma', 'acme/gamma', 'claude_execution'],
    ['run-retired', 'acme/retired', 'claude_execution'],
  ] as const) {
    await insertTask(db, { taskId, repository, createdAt: at(3_600_000), issueNumber: 7, job: { title: `Work ${taskId}` } });
    await insertHistory(db, { taskId, state: 'pending', timestamp: at(3_600_000) });
    if (state !== 'queued') {
      await insertHistory(db, { taskId, state, timestamp: at(600_000), reason: `Reached ${state}` });
    }
  }
  // A task with no history at all has been accepted but never started.
  await insertTask(db, { taskId: 'fresh-alpha', repository: 'acme/alpha', createdAt: at(300_000) });

  const digest = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(digest.repositories, ['acme/alpha']);
  assert.equal(digest.repositoriesTruncated, false);
  assert.equal(digest.window, null);
  assert.ok(Date.parse(digest.asOf) > 0);

  assert.deepEqual(ids(digest.sections.runningTasks.items, task => task.taskId), ['run-alpha']);
  assert.equal(digest.sections.runningTasks.items[0].state, 'codex_execution');
  assert.equal(digest.sections.runningTasks.items[0].repository, 'acme/alpha');
  assert.equal(digest.sections.runningTasks.items[0].issueNumber, 7);
  assert.equal(digest.sections.runningTasks.items[0].stateReason, 'Reached codex_execution');
  assert.ok(digest.sections.runningTasks.items[0].elapsedSeconds >= 0);
  assert.deepEqual(ids(digest.sections.queued.items, task => task.taskId).sort(), ['fresh-alpha', 'queued-alpha']);
  assert.deepEqual(ids(digest.sections.blockers.items, blocker => blocker.reference.taskId), ['failed-alpha']);
  assert.equal(digest.sections.blockers.items[0].kind, 'task');
  assert.match(digest.sections.blockers.items[0].summary, /^Task failed/);
  assertSectionsConsistent(digest.sections);

  // An explicit repository narrows the digest without re-deriving the grant.
  const scoped = await callTool(deps, principal, 'get_current_activity', { repository: 'acme/alpha' });
  assert.deepEqual(scoped.repositories, ['acme/alpha']);
});

test('current activity paginates sections and reports truncation', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);
  for (let index = 0; index < 4; index++) {
    const taskId = `run-${index}`;
    await insertTask(db, { taskId, repository: 'acme/alpha', createdAt: at(3_600_000) });
    await insertHistory(db, { taskId, state: 'claude_execution', timestamp: at(600_000 - index * 1000) });
  }
  const digest = await callTool(deps, principal, 'get_current_activity', { limit: 2 });
  assert.equal(digest.sections.runningTasks.count, 2);
  assert.equal(digest.sections.runningTasks.truncated, true);
  assert.deepEqual(ids(digest.sections.runningTasks.items, task => task.taskId), ['run-3', 'run-2']);
  // Repeated calls keep the same order for equal timestamps.
  const repeat = await callTool(deps, principal, 'get_current_activity', { limit: 2 });
  assert.deepEqual(repeat.sections.runningTasks.items, digest.sections.runningTasks.items);
});

test('another user’s private goal task never appears in the digest', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);

  await insertTask(db, { taskId: 'mine', repository: 'acme/alpha', createdAt: at(3_600_000), taskType: 'goal' });
  await insertTask(db, { taskId: 'theirs', repository: 'acme/alpha', createdAt: at(3_600_000), taskType: 'goal' });
  await insertTask(db, { taskId: 'orphan-goal', repository: 'acme/alpha', createdAt: at(3_600_000), taskType: 'goal' });
  for (const taskId of ['mine', 'theirs', 'orphan-goal']) {
    await insertHistory(db, { taskId, state: 'claude_execution', timestamp: at(600_000) });
  }
  await insertGoal(db, {
    goal_id: '11111111-1111-4111-8111-111111111111', repository: 'acme/alpha', current_task_id: 'mine',
    title: 'My goal', started_at: at(1_200_000), created_at: at(1_200_000), updated_at: at(600_000),
  });
  await insertGoal(db, {
    goal_id: '22222222-2222-4222-8222-222222222222', owner_id: '999', owner_login: 'other',
    repository: 'acme/alpha', current_task_id: 'theirs', title: 'Their goal',
    started_at: at(1_200_000), created_at: at(1_200_000), updated_at: at(600_000),
  });

  const digest = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(ids(digest.sections.runningTasks.items, task => task.taskId), ['mine']);
  assert.deepEqual(ids(digest.sections.activeGoals.items, goal => goal.goalId), ['11111111-1111-4111-8111-111111111111']);
  assert.equal(digest.sections.activeGoals.items[0].title, 'My goal');
  assert.equal(digest.sections.activeGoals.items[0].currentTaskId, 'mine');
  assert.equal(digest.sections.activeGoals.items[0].narration, null);
  assert.doesNotMatch(JSON.stringify(digest), /theirs|orphan-goal|Their goal/);
});

test('plans in progress and blocked goals reach the right sections', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);

  await db('task_drafts').insert([
    { draft_id: 'plan-generating', user_id: owner, repository: 'acme/alpha', name: 'Generating plan', status: 'generating', created_at: at(600_000), updated_at: at(300_000) },
    { draft_id: 'plan-refining', user_id: owner, repository: 'acme/alpha', name: 'Refining plan', status: 'refining', created_at: at(900_000), updated_at: at(600_000) },
    { draft_id: 'plan-draft', user_id: owner, repository: 'acme/alpha', name: 'Idle draft', status: 'draft', created_at: at(900_000), updated_at: at(900_000) },
    { draft_id: 'plan-other-user', user_id: '999', repository: 'acme/alpha', name: 'Someone else', status: 'generating', created_at: at(900_000), updated_at: at(60_000) },
  ]);
  await insertTask(db, { taskId: 'failed-goal-task', repository: 'acme/alpha', createdAt: at(3_600_000), taskType: 'goal' });
  await insertTask(db, { taskId: 'paused-goal-task', repository: 'acme/alpha', createdAt: at(3_600_000), taskType: 'goal' });
  await insertGoal(db, {
    goal_id: '33333333-3333-4333-8333-333333333333', repository: 'acme/alpha', current_task_id: 'failed-goal-task',
    title: 'Broken goal', result_state: 'failed', failure_reason: 'Agent exited early',
    created_at: at(3_600_000), updated_at: at(600_000), completed_at: at(600_000),
  });
  await insertGoal(db, {
    goal_id: '44444444-4444-4444-8444-444444444444', repository: 'acme/alpha', current_task_id: 'paused-goal-task',
    title: 'Waiting goal', desired_state: 'paused', created_at: at(3_600_000), updated_at: at(300_000),
  });

  const digest = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(ids(digest.sections.plansInProgress.items, plan => plan.planId), ['plan-generating', 'plan-refining']);
  assert.equal(digest.sections.plansInProgress.items[0].status, 'generating');
  assert.equal(digest.sections.plansInProgress.items[0].title, 'Generating plan');
  assert.deepEqual(digest.sections.activeGoals.items, []);
  const blockers = digest.sections.blockers.items as Array<{ summary: string; reference: { goalId?: string } }>;
  assert.deepEqual(blockers.map(blocker => blocker.reference.goalId), [
    '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333',
  ]);
  assert.match(blockers[0].summary, /^Goal paused, awaiting input — Waiting goal$/);
  assert.match(blockers[1].summary, /^Goal failed — Broken goal — Agent exited early$/);
});

test('the noise filter keeps critical notifications and includeRoutine restores the rest', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories('acme/alpha');
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha']);

  await insertNotification(db, {
    id: 'system-error', kind: 'system_failure', severity: 'error',
    target: { type: 'system_failure', component: 'worker' },
    title: 'System component unhealthy: worker', body: 'worker reported “degraded”.', occurredAt: at(300_000),
  });
  await insertNotification(db, {
    id: 'seat-limit', kind: 'system_failure', severity: 'warning',
    target: { type: 'system_failure', component: 'connect-seat-limit' },
    title: 'GitHub event blocked by seat limit', body: 'No developer seat was available.',
    metadata: { seatsRemaining: 0 }, occurredAt: at(400_000),
  });
  await insertNotification(db, {
    id: 'routine-success', kind: 'task', severity: 'success',
    target: { type: 'task', repository: 'acme/alpha', taskId: 'done-1' },
    title: 'Implementation completed', body: 'Open task details to review the result.', occurredAt: at(500_000),
  });
  await insertNotification(db, {
    id: 'routine-info', kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'acme/alpha', prNumber: 42 },
    title: 'PR #42 ready for review', body: 'PR #42 is ready for review.', occurredAt: at(600_000),
  });
  await insertNotification(db, {
    id: 'stalled-review', kind: 'review', severity: 'info',
    target: { type: 'review', repository: 'acme/alpha', prNumber: 43 },
    title: 'Review stopped', body: 'The review run did not finish.',
    metadata: { state: 'failed' }, occurredAt: at(700_000),
  });

  const filtered = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(ids(filtered.sections.blockers.items, blocker => blocker.reference.notificationId),
    ['system-error', 'seat-limit', 'stalled-review']);

  const unfiltered = await callTool(deps, principal, 'get_current_activity', { includeRoutine: true, limit: 50 });
  assert.deepEqual(ids(unfiltered.sections.blockers.items, blocker => blocker.reference.notificationId),
    ['system-error', 'seat-limit', 'routine-success', 'routine-info', 'stalled-review']);

  // A repository-scoped digest never exposes system notifications.
  const scoped = await callTool(deps, principal, 'get_current_activity', { repository: 'acme/alpha' });
  assert.deepEqual(ids(scoped.sections.blockers.items, blocker => blocker.reference.notificationId), ['stalled-review']);
});

test('the noise predicate is closed over today’s kinds and severities', () => {
  const routine = { kind: 'task', severity: 'success', target: { type: 'task', repository: 'acme/alpha', taskId: 't' } };
  assert.equal(isOperatorRelevant(routine), false);
  assert.equal(isOperatorRelevant(routine, { includeRoutine: true }), true);
  assert.equal(isOperatorRelevant({ kind: 'task', severity: 'error', target: {} }), true);
  assert.equal(isOperatorRelevant({ kind: 'system_failure', severity: 'warning', target: {} }), true);
  assert.equal(isOperatorRelevant({ kind: 'plan', severity: 'info', metadata: { agentAvailable: false } }), true);
  assert.equal(isOperatorRelevant({ kind: 'plan', severity: 'info', metadata: { credentialRequired: true } }), true);
  assert.equal(isOperatorRelevant({ kind: 'plan', severity: 'info', metadata: { quotaExceeded: true } }), true);
  assert.equal(isOperatorRelevant({ kind: 'review', severity: 'info', metadata: { ultrafixStopReason: 'label_removed' } }), true);
  assert.equal(isOperatorRelevant({ kind: 'review', severity: 'info', metadata: { ultrafixStopReason: 'Goal reached' } }), false);
  // A kind added after this table was written is excluded unless it is an
  // error, even when it carries a signal this table would otherwise recognize.
  assert.equal(isOperatorRelevant({ kind: 'deployment', severity: 'info', metadata: {} }), false);
  assert.equal(isOperatorRelevant({ kind: 'deployment', severity: 'info', metadata: { state: 'failed' } }), false);
  assert.equal(isOperatorRelevant({ kind: 'deployment', severity: 'info', target: { agentAvailable: false } }), false);
  assert.equal(isOperatorRelevant({ kind: 'deployment', severity: 'error', metadata: {} }), true);
  assert.equal(
    isOperatorRelevant({ kind: 'deployment', severity: 'info', metadata: { state: 'failed' } }, { includeRoutine: true }),
    true,
  );
});

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
