import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';
import {
  assertSectionsConsistent, at, buildDeps, buildPrincipal, configuredRepositories,
  createActivityDatabase, ids, insertGoal, insertHistory, insertNotification, insertTask,
  owner, repositories,
} from './fixtures/mcpActivity.js';

const core = await import('@propr/core');
const coreMock = await mock.module('@propr/core', {
  namedExports: { ...core, loadMonitoredReposRaw: async () => configuredRepositories.current },
});
after(async () => { coreMock.restore(); await core.closeConnection(); });

const { createToolCatalog } = await import('../mcp/tools.js');
const { isOperatorRelevant } = await import('../mcp/activityDigest.js');

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

test('a repository configured for several base branches counts once against the repository cap', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  const others = Array.from({ length: 19 }, (_, index) => `acme/repo-${index}`);
  // Twenty distinct repositories, alpha configured three times.
  configuredRepositories.current = [
    { id: 'alpha-main', name: 'acme/alpha', enabled: true, baseBranch: 'main' },
    { id: 'alpha-release', name: 'acme/alpha', enabled: true, baseBranch: 'release' },
    { id: 'alpha-case', name: 'ACME/Alpha', enabled: true, baseBranch: 'hotfix' },
    ...others.map(name => ({ id: name, name, enabled: true, baseBranch: 'main' })),
  ];
  const deps = buildDeps(db);
  const principal = buildPrincipal(['acme/alpha', ...others]);
  await insertTask(db, { taskId: 'run-alpha', repository: 'acme/alpha', createdAt: at(3_600_000) });
  await insertHistory(db, { taskId: 'run-alpha', state: 'claude_execution', timestamp: at(600_000) });

  for (const name of ['get_current_activity', 'get_recent_activity'] as const) {
    const digest = await callTool(deps, principal, name);
    assert.deepEqual(digest.repositories, ['acme/alpha', ...others], name);
    assert.equal(digest.repositoriesTruncated, false, name);
  }
  const current = await callTool(deps, principal, 'get_current_activity');
  assert.deepEqual(ids(current.sections.runningTasks.items, task => task.taskId), ['run-alpha']);
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
  await insertTask(db, { taskId: 'resuming-goal-task', repository: 'acme/alpha', createdAt: at(3_600_000), taskType: 'goal' });
  await insertTask(db, { taskId: 'pausing-goal-task', repository: 'acme/alpha', createdAt: at(3_600_000), taskType: 'goal' });
  await insertGoal(db, {
    goal_id: '33333333-3333-4333-8333-333333333333', repository: 'acme/alpha', current_task_id: 'failed-goal-task',
    title: 'Broken goal', result_state: 'failed', failure_reason: 'Agent exited early',
    created_at: at(3_600_000), updated_at: at(600_000), completed_at: at(600_000),
  });
  await insertGoal(db, {
    goal_id: '44444444-4444-4444-8444-444444444444', repository: 'acme/alpha', current_task_id: 'paused-goal-task',
    title: 'Waiting goal', desired_state: 'paused', pause_confirmed_at: at(400_000),
    created_at: at(3_600_000), updated_at: at(300_000),
  });
  // Still paused, but a resume is queued: get_goal says it is not waiting, so neither may the digest.
  await insertGoal(db, {
    goal_id: '55555555-5555-4555-8555-555555555555', repository: 'acme/alpha', current_task_id: 'resuming-goal-task', title: 'Resuming goal',
    desired_state: 'paused', pause_confirmed_at: at(400_000), resume_requested: true,
    created_at: at(3_600_000), updated_at: at(200_000),
  });
  // A pause the runner has not confirmed yet is not the operator's turn either.
  await insertGoal(db, {
    goal_id: '66666666-6666-4666-8666-666666666666', repository: 'acme/alpha', current_task_id: 'pausing-goal-task', title: 'Pausing goal',
    desired_state: 'paused', created_at: at(3_600_000), updated_at: at(100_000),
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
  assert.doesNotMatch(JSON.stringify(digest.sections.blockers), /Resuming goal|Pausing goal/);
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
