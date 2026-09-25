import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ToolDeps, McpTool } from '../mcp/tools.js';

const repository = 'acme/repo';
const otherRepository = 'acme/other';
const forbiddenRepository = 'acme/forbidden';
const disabledRepository = 'acme/disabled';
const ownerId = '123';
const strangerId = '999';

const runningGoalId = '11111111-1111-4111-8111-111111111111';
const completedGoalId = '22222222-2222-4222-8222-222222222222';
const failedGoalId = '33333333-3333-4333-8333-333333333333';
const forbiddenGoalId = '44444444-4444-4444-8444-444444444444';
const disabledGoalId = '55555555-5555-4555-8555-555555555555';
const pausedGoalId = '66666666-6666-4666-8666-666666666666';
const strangerGoalId = '77777777-7777-4777-8777-777777777777';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const goalDefaults = {
  owner_id: ownerId, owner_login: 'tester', objective: 'Fixture objective', launch_strategy: 'direct',
  initial_prompt: 'Fixture prompt', agent_id: 'claude', agent_alias: 'claude', agent_type: 'claude',
  requested_model: 'fixture-model', desired_state: 'running', artifact_refs: '[]', artifact_stats: '{}',
  run_generation: 0, paused_ms: 0, resume_requested: false, control_generation: 0, control_ack_generation: 0,
  checkpoint_count: 0,
};

const inputDefaults = { attachment_count: 0, display_message: null, delivered_at: null };

async function seed(db: Knex): Promise<void> {
  await db('goals').insert([
    { goal_id: runningGoalId, repository, current_task_id: 'goal-task-running', final_pr_number: 41,
      checkpoint_interval_minutes: 15, checkpoint_count: 2, last_checkpoint_at: '2026-09-01 12:00:10',
      last_checkpoint_commit_sha: 'abc1234', created_at: '2026-09-01 12:00:00', updated_at: '2026-09-01 12:00:30',
      started_at: '2026-09-01 12:00:00' },
    { goal_id: completedGoalId, repository: otherRepository, current_task_id: 'goal-task-completed',
      result_state: 'completed', created_at: '2026-08-01 12:00:00', updated_at: '2026-08-01 12:00:30',
      started_at: '2026-08-01 12:00:00', completed_at: '2026-08-01 12:00:30' },
    { goal_id: failedGoalId, repository, current_task_id: 'goal-task-failed', result_state: 'failed',
      failure_reason: 'Fixture agent stopped', created_at: '2026-07-01 12:00:00', updated_at: '2026-07-01 12:00:30' },
    { goal_id: forbiddenGoalId, repository: forbiddenRepository, current_task_id: 'goal-task-forbidden',
      created_at: '2026-09-01 12:00:00', updated_at: '2026-09-01 12:00:00' },
    { goal_id: disabledGoalId, repository: disabledRepository, current_task_id: 'goal-task-disabled',
      created_at: '2026-09-01 12:00:00', updated_at: '2026-09-01 12:00:00' },
    { goal_id: pausedGoalId, repository, current_task_id: 'goal-task-paused', desired_state: 'paused',
      pause_confirmed_at: '2026-06-01 12:00:10', created_at: '2026-06-01 12:00:00', updated_at: '2026-06-01 12:00:10' },
    { goal_id: strangerGoalId, owner_id: strangerId, repository, current_task_id: 'private-goal-task',
      created_at: '2026-09-01 12:00:00', updated_at: '2026-09-01 12:00:00' },
  ].map(row => ({ ...goalDefaults, ...row })));

  await db('tasks').insert([
    { task_id: 'goal-task-running', repository, task_type: 'goal', correlation_id: runningGoalId, created_at: '2026-09-01 12:00:00' },
    { task_id: 'goal-task-completed', repository: otherRepository, task_type: 'goal', correlation_id: completedGoalId, created_at: '2026-08-01 12:00:00' },
    { task_id: 'goal-task-failed', repository, task_type: 'goal', correlation_id: failedGoalId, created_at: '2026-07-01 12:00:00' },
    { task_id: 'goal-task-forbidden', repository: forbiddenRepository, task_type: 'goal', correlation_id: forbiddenGoalId, created_at: '2026-09-01 12:00:00' },
    { task_id: 'goal-task-disabled', repository: disabledRepository, task_type: 'goal', correlation_id: disabledGoalId, created_at: '2026-09-01 12:00:00' },
    { task_id: 'goal-task-paused', repository, task_type: 'goal', correlation_id: pausedGoalId, created_at: '2026-06-01 12:00:00' },
    { task_id: 'private-goal-task', repository, task_type: 'goal', correlation_id: strangerGoalId, created_at: '2026-09-01 12:00:00' },
    { task_id: 'goal-child-merged', repository, task_type: 'issue', correlation_id: runningGoalId, pr_number: 77, created_at: '2026-09-01 12:01:00' },
    { task_id: 'goal-child-failed', repository, task_type: 'issue', correlation_id: runningGoalId, created_at: '2026-09-01 12:02:00' },
    { task_id: 'plain-active', repository, task_type: 'issue', created_at: '2026-09-01 12:03:00' },
    { task_id: 'plain-other-repo', repository: otherRepository, task_type: 'issue', created_at: '2026-09-01 12:04:00' },
    { task_id: 'plain-forbidden', repository: forbiddenRepository, task_type: 'issue', created_at: '2026-09-01 12:05:00' },
    { task_id: 'plain-disabled', repository: disabledRepository, task_type: 'issue', created_at: '2026-09-01 12:06:00' },
  ]);

  await db('task_history').insert([
    { task_id: 'goal-task-running', state: 'processing', timestamp: '2026-09-01 12:00:01' },
    { task_id: 'goal-child-merged', state: 'processing', timestamp: '2026-09-01 12:01:01' },
    { task_id: 'goal-child-merged', state: 'completed', timestamp: '2026-09-01 12:01:41' },
    { task_id: 'goal-child-failed', state: 'processing', timestamp: '2026-09-01 12:02:01', reason: 'Started work' },
    { task_id: 'goal-child-failed', state: 'claude_execution', timestamp: '2026-09-01 12:02:11' },
    { task_id: 'goal-child-failed', state: 'failed', timestamp: '2026-09-01 12:02:21', reason: 'Fixture agent stopped' },
    { task_id: 'plain-active', state: 'processing', timestamp: '2026-09-01 12:03:01' },
    { task_id: 'plain-other-repo', state: 'completed', timestamp: '2026-09-01 12:04:01' },
    { task_id: 'plain-forbidden', state: 'completed', timestamp: '2026-09-01 12:05:01' },
    { task_id: 'plain-disabled', state: 'completed', timestamp: '2026-09-01 12:06:01' },
  ]);

  await db('notification_pull_request_state').insert([
    { repository, pr_number: 41, merged_at: '2026-09-01T12:00:40.000Z' },
    { repository, pr_number: 77, merged_at: '2026-09-01T12:01:45.000Z' },
  ]);

  await db('goal_inputs').insert([
    { input_id: 'input-1', goal_id: runningGoalId, owner_id: ownerId, idempotency_key: 'seed-input-1',
      operation: 'goal.input', payload_hash: 'hash-1', kind: 'input', message: 'First correction',
      display_message: 'First correction', state: 'delivered', created_at: '2026-09-01 12:00:05',
      delivered_at: '2026-09-01 12:00:06' },
    { input_id: 'input-2', goal_id: runningGoalId, owner_id: ownerId, idempotency_key: 'seed-input-2',
      operation: 'goal.input', payload_hash: 'hash-2', kind: 'input', message: 'Second correction',
      display_message: 'Second correction', state: 'pending', created_at: '2026-09-01 12:00:07' },
    { input_id: 'input-3', goal_id: runningGoalId, owner_id: ownerId, idempotency_key: 'seed-input-3',
      operation: 'goal.input', payload_hash: 'hash-3', kind: 'input', message: 'Third correction',
      display_message: 'Third correction', state: 'pending', created_at: '2026-09-01 12:00:08' },
    { input_id: 'input-context', goal_id: runningGoalId, owner_id: ownerId, idempotency_key: 'seed-input-context',
      operation: 'goal.context', payload_hash: 'hash-4', kind: 'context', message: 'ProPR delivery policy',
      state: 'delivered', created_at: '2026-09-01 12:00:09' },
    { input_id: 'input-stranger', goal_id: strangerGoalId, owner_id: strangerId, idempotency_key: 'seed-input-stranger',
      operation: 'goal.input', payload_hash: 'hash-5', kind: 'input', message: 'Private correction',
      display_message: 'Private correction', state: 'pending', created_at: '2026-09-01 12:00:09' },
  ].map(row => ({ ...inputDefaults, ...row })));
}

test('MCP goal and task depth lists across the grant, reads live detail and records corrective input', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-depth-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  const configured = [
    { name: repository, enabled: true, baseBranch: 'main' },
    { name: otherRepository, enabled: true, baseBranch: 'main' },
    { name: forbiddenRepository, enabled: true, baseBranch: 'main' },
    { name: disabledRepository, enabled: false, baseBranch: 'main' },
  ];
  const boundary = await mock.module('@propr/core', { namedExports: { ...core,
    loadMonitoredReposRaw: async () => configured,
  } });
  const { McpError } = await import('../mcp/config.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { createToolCatalog, executeTool } = await import('../mcp/tools.js');

  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const liveOutput = new Map<string, string>([
    ['agent:output:goal-task-running', [
      { type: 'assistant', timestamp: '2026-09-01T12:00:20.000Z', message: { content: [
        { type: 'thinking', thinking: 'Hidden goal reasoning' },
        { type: 'text', text: 'Rewriting the retry path for the goal.' },
      ] } },
    ].map(event => JSON.stringify(event)).join('\n')],
    ['agent:output:goal-child-failed', JSON.stringify({
      type: 'assistant', timestamp: '2026-09-01T12:02:15.000Z', message: { content: [
        { type: 'thinking', thinking: 'Hidden task reasoning' },
        { type: 'text', text: 'Inspecting the failing fixture before giving up.' },
      ] },
    })],
  ]);
  const fileChanges = new Map<string, string>();
  const redisClient = { get: async (key: string) => fileChanges.get(key) ?? liveOutput.get(key) ?? null } as unknown as RedisClientType;

  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    await seed(db);
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'depth-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
    policy.repository = async (_principal, target) => {
      if (target === forbiddenRepository) throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403);
    };
    const deps: ToolDeps = { db, policy, redisClient, taskQueue: {} as never, runtimeBuildQueue: {} as never,
      goalServices: { loadVisualPreviewSettings: async () => ({ enabled: false, types: ['image'] }),
        processAttachments: async () => [], uploadIdentity: async () => [],
        stopExecution: async () => ({ success: true, containerStopped: true, removedQueuedJobs: 0 }) as never } };
    const catalog = createToolCatalog(deps);
    const principal = { user: { id: ownerId, username: 'tester', login: 'tester' },
      authorization: { role: 'member', source: 'local', permissions: [] },
      scopes: ['read', 'execute'],
      grant: { id: 'depth-grant', ownerId, clientId: 'client', clientName: 'Depth', instanceId: config.instanceId,
        resource: config.resource, scopes: ['read', 'execute'],
        repositories: [repository, otherRepository, forbiddenRepository, disabledRepository],
        createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' } } as unknown as McpPrincipal;
    const tool = (name: string): McpTool => catalog.find(candidate => candidate.name === name)!;
    const call = async (name: string, args: Record<string, unknown>, caller = principal): Promise<Json> =>
      (await executeTool(tool(name), args, caller, deps)).data as Json;

    // Repository-optional listing resolves the grant intersected with enabled configuration.
    const everyGoal = await call('list_goals', {});
    assert.deepEqual(everyGoal.goals.map((goal: Json) => goal.goal_id),
      [runningGoalId, completedGoalId, failedGoalId, pausedGoalId]);
    assert.equal(everyGoal.nextOffset, null);
    assert.doesNotMatch(JSON.stringify(everyGoal), new RegExp(`${forbiddenGoalId}|${disabledGoalId}|${strangerGoalId}`));

    // Supplying an exact repository keeps the existing behaviour and result shape. Only the
    // wall-clock elapsed_ms of still-running work differs between two reads of the same rows.
    const stable = (items: Json[]): Json[] =>
      items.map(({ elapsed_ms, ...rest }) => ({ ...rest, elapsed_ms: typeof elapsed_ms === 'number' }));
    const repositoryGoals = await call('list_goals', { repository });
    assert.deepEqual(stable(repositoryGoals.goals),
      stable(everyGoal.goals.filter((goal: Json) => goal.repository === repository)));
    assert.equal(repositoryGoals.nextOffset, null);
    assert.deepEqual(stable((await call('list_goals', { repository, state: 'all' })).goals), stable(repositoryGoals.goals));

    // Cross-repository paging is bounded by the database, not by slicing every repository in memory.
    const firstGoalPage = await call('list_goals', { limit: 2 });
    assert.deepEqual(firstGoalPage.goals.map((goal: Json) => goal.goal_id), [runningGoalId, completedGoalId]);
    assert.equal(firstGoalPage.nextOffset, 2);
    const secondGoalPage = await call('list_goals', { limit: 2, offset: firstGoalPage.nextOffset });
    assert.deepEqual(secondGoalPage.goals.map((goal: Json) => goal.goal_id), [failedGoalId, pausedGoalId]);
    // The existing paging contract offers a continuation whenever a full page was returned.
    assert.equal(secondGoalPage.nextOffset, 4);
    assert.deepEqual(await call('list_goals', { limit: 2, offset: secondGoalPage.nextOffset }),
      { goals: [], nextOffset: null });

    assert.deepEqual((await call('list_goals', { state: 'active' })).goals.map((goal: Json) => goal.goal_id),
      [runningGoalId, pausedGoalId]);
    assert.deepEqual((await call('list_goals', { state: 'completed' })).goals.map((goal: Json) => goal.goal_id),
      [completedGoalId]);
    assert.deepEqual((await call('list_goals', { state: 'failed' })).goals.map((goal: Json) => goal.goal_id),
      [failedGoalId]);
    assert.deepEqual((await call('list_goals', { repository: otherRepository, state: 'failed' })).goals, []);

    const everyTask = await call('list_tasks', {});
    const taskIds = everyTask.tasks.map((task: Json) => task.task_id);
    assert.deepEqual(taskIds, ['plain-other-repo', 'plain-active', 'goal-child-failed', 'goal-child-merged',
      'goal-task-running', 'goal-task-completed', 'goal-task-failed', 'goal-task-paused']);
    assert.ok(!taskIds.includes('private-goal-task'), 'another user’s private goal task stays invisible');
    assert.doesNotMatch(JSON.stringify(everyTask), /plain-forbidden|plain-disabled|goal-task-forbidden|goal-task-disabled/);
    const repositoryTasks = await call('list_tasks', { repository });
    assert.deepEqual(stable(repositoryTasks.tasks),
      stable(everyTask.tasks.filter((task: Json) => task.repository === repository)));
    assert.equal(repositoryTasks.nextOffset, null);

    assert.deepEqual((await call('list_tasks', { state: 'active' })).tasks.map((task: Json) => task.task_id),
      ['plain-active', 'goal-task-running', 'goal-task-completed', 'goal-task-failed', 'goal-task-paused']);
    assert.deepEqual((await call('list_tasks', { state: 'completed' })).tasks.map((task: Json) => task.task_id),
      ['plain-other-repo', 'goal-child-merged']);
    assert.deepEqual((await call('list_tasks', { state: 'failed' })).tasks.map((task: Json) => task.task_id),
      ['goal-child-failed']);
    const activeTaskPage = await call('list_tasks', { state: 'active', limit: 2 });
    assert.deepEqual(activeTaskPage.tasks.map((task: Json) => task.task_id), ['plain-active', 'goal-task-running']);
    assert.equal(activeTaskPage.nextOffset, 2);

    // Goal detail answers "what is happening and what has already been done" in one call.
    const goal = await call('get_goal', { repository, goalId: runningGoalId });
    assert.equal(goal.goal.id, runningGoalId);
    assert.deepEqual(goal.currentActivity.entries,
      [{ timestamp: '2026-09-01T12:00:20.000Z', message: 'Rewriting the retry path for the goal.' }]);
    assert.equal(goal.currentActivity.order, 'newest_first');
    assert.doesNotMatch(JSON.stringify(goal.currentActivity), /Hidden goal reasoning/);
    assert.deepEqual(goal.progress.tasks, { total: 3, active: 1, completed: 1, failed: 1, cancelled: 0 });
    assert.deepEqual(goal.progress.recentTerminalTransitions, [
      { taskId: 'goal-child-failed', state: 'failed', at: '2026-09-01 12:02:21', reason: 'Fixture agent stopped' },
      { taskId: 'goal-child-merged', state: 'completed', at: '2026-09-01 12:01:41', reason: null },
    ]);
    assert.equal(goal.progress.startedAt, '2026-09-01 12:00:00');
    assert.ok(Number.isSafeInteger(goal.progress.elapsedSeconds) && goal.progress.elapsedSeconds > 0);
    assert.deepEqual(goal.progress.checkpoint, { intervalMinutes: 15, count: 2, lastAt: '2026-09-01 12:00:10',
      lastCommitSha: 'abc1234', error: null });
    assert.deepEqual(goal.pendingInput, { waitingForOperator: false, reason: null, undeliveredInputs: 2,
      lastInputAt: '2026-09-01 12:00:08', lastInputDeliveredAt: null });
    assert.deepEqual(goal.pullRequests, [
      { number: 41, state: 'merged', role: 'final' },
      { number: 77, state: 'merged', role: 'task', taskId: 'goal-child-merged' },
    ]);

    // A confirmed pause with no queued resume is the durable "your turn" signal.
    const paused = await call('get_goal', { repository, goalId: pausedGoalId });
    assert.equal(paused.pendingInput.waitingForOperator, true);
    assert.equal(paused.pendingInput.reason, 'paused_awaiting_resume_or_input');
    assert.equal(paused.pendingInput.undeliveredInputs, 0);
    assert.equal(paused.progress.checkpoint, null, 'absent checkpoint state never reads as a zeroed checkpoint');
    assert.deepEqual(paused.pullRequests, []);

    const completed = await call('get_goal', { repository: otherRepository, goalId: completedGoalId });
    assert.equal(completed.progress.elapsedSeconds, 30);

    // Task detail carries recent events, narration, timing, change counts and the linked PR.
    const failedTask = await call('get_task', { repository, taskId: 'goal-child-failed' });
    assert.equal(failedTask.latestEvent.state, 'failed');
    assert.deepEqual(failedTask.latestEvents, [
      { state: 'failed', reason: 'Fixture agent stopped', timestamp: '2026-09-01 12:02:21' },
      { state: 'claude_execution', reason: null, timestamp: '2026-09-01 12:02:11' },
      { state: 'processing', reason: 'Started work', timestamp: '2026-09-01 12:02:01' },
    ]);
    assert.deepEqual(failedTask.currentActivity.entries,
      [{ timestamp: '2026-09-01T12:02:15.000Z', message: 'Inspecting the failing fixture before giving up.' }]);
    assert.doesNotMatch(JSON.stringify(failedTask.currentActivity), /Hidden task reasoning/);
    assert.deepEqual(failedTask.timing, { startedAt: '2026-09-01 12:02:01', updatedAt: '2026-09-01 12:02:21',
      completedAt: '2026-09-01 12:02:21', elapsedSeconds: 20 });
    assert.equal(failedTask.changesSummary, null, 'unpersisted file changes never read as zero changes');
    assert.equal(failedTask.pullRequest, null);

    fileChanges.set('task:file-changes:goal-child-failed', JSON.stringify({
      taskId: 'goal-child-failed', lastUpdated: '2026-09-01T12:02:20.000Z', files: [],
    }));
    fileChanges.set('task:file-changes:goal-child-merged', JSON.stringify({
      taskId: 'goal-child-merged', lastUpdated: '2026-09-01T12:01:40.000Z', files: [
        { path: 'src/retry.ts', linesAdded: 12, linesRemoved: 3, status: 'modified', diff: '+retry\n' },
        { path: 'src/retry.test.ts', linesAdded: 30, linesRemoved: 0, status: 'added', diff: '+test\n' },
      ],
    }));
    assert.deepEqual((await call('get_task', { repository, taskId: 'goal-child-failed' })).changesSummary,
      { fileCount: 0, linesAdded: 0, linesRemoved: 0, lastUpdated: '2026-09-01T12:02:20.000Z' });
    const mergedTask = await call('get_task', { repository, taskId: 'goal-child-merged' });
    assert.deepEqual(mergedTask.changesSummary,
      { fileCount: 2, linesAdded: 42, linesRemoved: 3, lastUpdated: '2026-09-01T12:01:40.000Z' });
    assert.deepEqual(mergedTask.pullRequest, { number: 77, state: 'merged' });
    assert.doesNotMatch(JSON.stringify(mergedTask), /\+retry|\+test/);

    // Operator inputs already persisted are readable, newest first and bounded.
    const firstInputs = await call('list_goal_inputs', { repository, goalId: runningGoalId, limit: 2 });
    assert.equal(firstInputs.order, 'newest_first');
    assert.deepEqual(firstInputs.inputs.map((input: Json) => input.id), ['input-3', 'input-2']);
    assert.equal(firstInputs.nextOffset, 2);
    const secondInputs = await call('list_goal_inputs', { repository, goalId: runningGoalId, limit: 2, offset: 2 });
    assert.deepEqual(secondInputs.inputs, [{ id: 'input-1', message: 'First correction', attachmentCount: 0,
      state: 'delivered', createdAt: '2026-09-01 12:00:05', deliveredAt: '2026-09-01 12:00:06' }]);
    assert.equal(secondInputs.nextOffset, null);
    assert.doesNotMatch(JSON.stringify(firstInputs), /ProPR delivery policy/);

    // Both corrective kinds map onto the single durable goal input this backend persists.
    for (const [index, kind] of ['instruction', 'question'].entries()) {
      const sent = await call('send_goal_input', { repository, goalId: runningGoalId, message: `Correction ${kind}`,
        kind, idempotencyKey: `depth-input-${index}` });
      assert.equal(sent.state, 'completed', JSON.stringify(sent));
      const persisted = await db('goal_inputs').where({ goal_id: runningGoalId, message: `Correction ${kind}` }).first();
      assert.equal(persisted.kind, 'input');
      assert.equal(persisted.operation, 'goal.input');
    }
    assert.equal((await call('list_goal_inputs', { repository, goalId: runningGoalId, limit: 2 })).nextOffset, 2);
    assert.deepEqual((await call('list_goal_inputs', { repository, goalId: runningGoalId })).inputs
      .map((input: Json) => input.message),
    ['Correction question', 'Correction instruction', 'Third correction', 'Second correction', 'First correction']);
    await assert.rejects(() => call('send_goal_input', { repository, goalId: runningGoalId,
      message: 'Correction instruction', kind: 'question', idempotencyKey: 'depth-input-0' }),
    /already used with different arguments/);

    // Every new path keeps owner scoping and the private-goal-task visibility rules.
    for (const args of [{ repository, goalId: strangerGoalId }]) {
      await assert.rejects(() => call('get_goal', args), /Target not found/);
      await assert.rejects(() => call('list_goal_inputs', args), /Target not found/);
    }
    await assert.rejects(() => call('get_task', { repository, taskId: 'private-goal-task' }), /Target not found|Task not found/);
    await assert.rejects(() => call('list_goals', { repository: forbiddenRepository }), /Denied/);
    await assert.rejects(() => call('list_tasks', { repository: forbiddenRepository }), /Denied/);
    const stranger = { ...principal, user: { ...principal.user, id: strangerId } } as McpPrincipal;
    const strangerGoals = await call('list_goals', {}, stranger);
    assert.deepEqual(strangerGoals.goals.map((goal: Json) => goal.goal_id), [strangerGoalId]);
    const strangerTasks = await call('list_tasks', {}, stranger);
    assert.ok(!strangerTasks.tasks.some((task: Json) => task.task_id === 'goal-task-running'));
    assert.ok(strangerTasks.tasks.some((task: Json) => task.task_id === 'private-goal-task'));
  } finally {
    boundary.restore();
    await db.destroy();
    await core.closeConnection();
    await rm(root, { recursive: true, force: true });
  }
});

test('goal progress counts every related task, not just the bounded detail rows', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    const { goalDetail } = await import('../mcp/goalTaskDetail.js');
    const goal = {
      goal_id: runningGoalId, owner_id: ownerId, repository, current_task_id: 'goal-task-running',
      desired_state: 'running', result_state: null, pause_confirmed_at: null, resume_requested: false,
      final_pr_number: null, started_at: '2026-09-01 12:00:00', created_at: '2026-09-01 12:00:00', completed_at: null,
      checkpoint_interval_minutes: null, last_checkpoint_at: null, last_checkpoint_commit_sha: null,
      checkpoint_count: 0, checkpoint_error: null,
    };
    await db('goals').insert({ ...goalDefaults, goal_id: goal.goal_id, repository, current_task_id: goal.current_task_id,
      created_at: goal.created_at, updated_at: goal.created_at, started_at: goal.started_at });
    // The running task is the oldest; a hundred newer completed children would push
    // it past a creation-ordered limit.
    await db('tasks').insert({ task_id: 'goal-task-running', repository, task_type: 'goal', correlation_id: goal.goal_id,
      pr_number: 9, created_at: '2026-09-01 12:00:00' });
    await db('task_history').insert({ task_id: 'goal-task-running', state: 'processing', timestamp: '2026-09-01 12:00:01' });
    const children = Array.from({ length: 100 }, (_, index) => `goal-child-${String(index).padStart(3, '0')}`);
    await db('tasks').insert(children.map((taskId, index) => ({ task_id: taskId, repository, task_type: 'issue',
      correlation_id: goal.goal_id, created_at: `2026-09-01 13:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}` })));
    for (let start = 0; start < children.length; start += 50) {
      await db('task_history').insert(children.slice(start, start + 50)
        .map(taskId => ({ task_id: taskId, state: 'completed', timestamp: '2026-09-01 14:00:00' })));
    }
    await db('task_history').insert({ task_id: 'goal-child-099', state: 'failed', timestamp: '2026-09-01 14:00:01' });

    const detail = await goalDetail({ db, redisClient: {} as RedisClientType }, goal as never, async () => {});
    assert.deepEqual(detail.progress.tasks, { total: 101, active: 1, completed: 99, failed: 1, cancelled: 0 });
    assert.equal(detail.progress.recentTerminalTransitions.length, 5);
    // The current task stays inside the bounded detail rows, so its pull request is reported.
    assert.ok(detail.pullRequests.some((pull: Json) => pull.number === 9 && pull.taskId === 'goal-task-running'));
  } finally {
    await db.destroy();
  }
});

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});
