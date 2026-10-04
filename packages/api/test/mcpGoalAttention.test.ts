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
import { withLiveOutputReads } from './liveOutputRedisFake.js';

const repository = 'acme/repo';
const otherRepository = 'acme/other';
const forbiddenRepository = 'acme/forbidden';
const ownerId = '123';
const strangerId = '999';

const questionGoalId = '11111111-1111-4111-8111-111111111111';
const pausedGoalId = '22222222-2222-4222-8222-222222222222';
const resumingGoalId = '33333333-3333-4333-8333-333333333333';
const staleGoalId = '44444444-4444-4444-8444-444444444444';
const quietGoalId = '55555555-5555-4555-8555-555555555555';
const forbiddenGoalId = '66666666-6666-4666-8666-666666666666';
const strangerGoalId = '77777777-7777-4777-8777-777777777777';
const approvalGoalId = '88888888-8888-4888-8888-888888888888';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const goalDefaults = {
  owner_id: ownerId, owner_login: 'tester', objective: 'Fixture objective', launch_strategy: 'direct',
  initial_prompt: 'Fixture prompt', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
  requested_model: 'fixture-model', desired_state: 'running', artifact_refs: '[]', artifact_stats: '{}',
  run_generation: 1, run_claim: 'claim-1', session_id: 'thread-1', paused_ms: 0, resume_requested: false,
  control_generation: 0, control_ack_generation: 0, checkpoint_count: 0,
  created_at: '2026-10-03 10:00:00', updated_at: '2026-10-03 10:00:00', started_at: '2026-10-03 10:00:00',
};

const blockerDefaults = {
  owner_id: ownerId, repository, run_generation: 1, run_claim: 'claim-1', session_id: 'thread-1', turn_id: 'turn-1',
  provider: 'codex', category: 'question', source: 'codex_app_server:item/tool/requestUserInput',
  response_actions: JSON.stringify(['send_input', 'pause', 'cancel']), status: 'open',
  first_observed_at: '2026-10-03 10:05:00', last_observed_at: '2026-10-03 10:05:00',
};

async function seed(db: Knex): Promise<void> {
  await db('goals').insert([
    { goal_id: questionGoalId, repository, title: 'Migrate the database', current_task_id: 'goal-task-question',
      created_at: '2026-10-03 10:07:00' },
    { goal_id: approvalGoalId, repository: otherRepository, title: 'Publish the package', current_task_id: 'goal-task-approval',
      created_at: '2026-10-03 10:06:00' },
    { goal_id: pausedGoalId, repository, title: 'Paused work', current_task_id: 'goal-task-paused', desired_state: 'paused',
      pause_confirmed_at: '2026-10-03 10:04:00', created_at: '2026-10-03 10:05:00' },
    { goal_id: resumingGoalId, repository, title: 'Resuming work', current_task_id: 'goal-task-resuming', desired_state: 'paused',
      pause_confirmed_at: '2026-10-03 10:04:00', resume_requested: true, created_at: '2026-10-03 10:04:00' },
    // Recovered onto a new attempt; the old attempt's question must not come back.
    { goal_id: staleGoalId, repository, title: 'Recovered work', current_task_id: 'goal-task-stale', run_generation: 2,
      run_claim: 'claim-2', session_id: 'thread-1', created_at: '2026-10-03 10:03:00' },
    // Running silently with queued corrections: nothing to ask the operator.
    { goal_id: quietGoalId, repository, title: 'Quiet work', current_task_id: 'goal-task-quiet', created_at: '2026-10-03 10:02:00' },
    { goal_id: forbiddenGoalId, repository: forbiddenRepository, current_task_id: 'goal-task-forbidden',
      created_at: '2026-10-03 10:01:00' },
    { goal_id: strangerGoalId, owner_id: strangerId, repository, current_task_id: 'goal-task-stranger',
      created_at: '2026-10-03 10:00:00' },
  ].map(row => ({ ...goalDefaults, ...row })));
  await db('goal_inputs').insert({
    input_id: '99999999-9999-4999-8999-999999999999', goal_id: quietGoalId, owner_id: ownerId, idempotency_key: 'quiet-input',
    operation: 'goal.input', payload_hash: 'hash', kind: 'input', message: 'Please also update the docs', state: 'pending',
    created_at: '2026-10-03 10:02:30',
  });
  await db('goal_blockers').insert([
    { ...blockerDefaults, blocker_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', goal_id: questionGoalId, task_id: 'goal-task-question',
      request_key: 'codex:thread-1:turn-1:item-1:user-input', summary: 'Which database should the migration target? <b>now</b>',
      questions: JSON.stringify([{ id: 'db', header: 'Database', question: 'Which database should the migration target? <b>now</b>',
        options: ['Postgres', 'SQLite'], confidential: false }]) },
    { ...blockerDefaults, blocker_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', goal_id: approvalGoalId, task_id: 'goal-task-approval',
      repository: otherRepository, category: 'approval', source: 'codex_app_server:item/commandExecution/requestApproval',
      request_key: 'codex:thread-1:turn-1:item-2:approval', summary: 'Approve command: npm publish',
      response_actions: JSON.stringify(['pause', 'cancel']) },
    { ...blockerDefaults, blocker_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', goal_id: staleGoalId, task_id: 'goal-task-stale',
      request_key: 'codex:thread-1:turn-1:item-3:user-input', summary: 'Stale question from the lost attempt' },
    { ...blockerDefaults, blocker_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', goal_id: quietGoalId, task_id: 'goal-task-quiet',
      request_key: 'codex:thread-1:turn-1:item-4:user-input', summary: 'Already answered', status: 'resolved' },
    { ...blockerDefaults, blocker_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', goal_id: forbiddenGoalId, task_id: 'goal-task-forbidden',
      repository: forbiddenRepository, request_key: 'codex:forbidden', summary: 'Forbidden repository question' },
    { ...blockerDefaults, blocker_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', goal_id: strangerGoalId, task_id: 'goal-task-stranger',
      owner_id: strangerId, request_key: 'codex:stranger', summary: 'Someone else\'s private question' },
  ]);
}

test('goal console, get_goal, attention listing, activity digest and dashboard agree on blockers with owner and repository scoping', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-goal-attention-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  const configured = [repository, otherRepository, forbiddenRepository].map(name => ({ name, enabled: true, baseBranch: 'main' }));
  const boundary = await mock.module('@propr/core', { namedExports: { ...core, loadMonitoredReposRaw: async () => configured } });
  const { McpError } = await import('../mcp/config.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
  const { createGoalRoutes } = await import('../routes/goalRoutes.js');
  const { loadDashboardWork } = await import('../routes/dashboardWorkQueries.js');

  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const redisClient = withLiveOutputReads({ get: async () => null }) as unknown as RedisClientType;
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    await seed(db);
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'attention-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
    policy.repository = async (_principal, target) => {
      if (target === forbiddenRepository) throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403);
    };
    const goalServices = { loadVisualPreviewSettings: async () => ({ enabled: false, types: ['image'] }),
      processAttachments: async () => [], uploadIdentity: async () => [],
      stopExecution: async () => ({ success: true, containerStopped: true, removedQueuedJobs: 0 }) as never };
    const deps: ToolDeps = { db, policy, redisClient, taskQueue: {} as never, runtimeBuildQueue: {} as never, goalServices: goalServices as never };
    const catalog = createToolCatalog(deps);
    const principal = { user: { id: ownerId, username: 'tester', login: 'tester' },
      authorization: { role: 'member', source: 'local', permissions: [] },
      scopes: ['read', 'execute'],
      grant: { id: 'attention-grant', ownerId, clientId: 'client', clientName: 'Attention', instanceId: config.instanceId,
        resource: config.resource, scopes: ['read', 'execute'],
        repositories: [repository, otherRepository, forbiddenRepository],
        createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' } } as unknown as McpPrincipal;
    const tool = (name: string): McpTool => catalog.find(candidate => candidate.name === name)!;
    const call = async (name: string, args: Record<string, unknown>): Promise<Json> =>
      (await executeTool(tool(name), args, principal, deps)).data as Json;

    // Bounded listing across the grant: explicit question and approval, plus the confirmed pause.
    const listed = await call('list_goal_attention', {});
    const byGoal = new Map<string, Json>(listed.goals.map((entry: Json) => [entry.goalId, entry]));
    assert.deepEqual([...byGoal.keys()].sort(), [questionGoalId, pausedGoalId, approvalGoalId].sort());
    assert.equal(listed.nextOffset, null);
    const question = byGoal.get(questionGoalId)!;
    assert.equal(question.reason, 'provider_question');
    assert.equal(question.blockers.length, 1);
    assert.equal(question.blockers[0].summary, 'Which database should the migration target? <b>now</b>',
      'untrusted provider text is carried verbatim as data');
    assert.deepEqual(question.blockers[0].responseActions, ['send_input', 'pause', 'cancel']);
    assert.deepEqual(byGoal.get(approvalGoalId)!.blockers[0].responseActions, ['pause', 'cancel']);
    assert.equal(byGoal.get(pausedGoalId)!.reason, 'paused_awaiting_resume_or_input');
    const listedText = JSON.stringify(listed);
    for (const hidden of ['Stale question', 'Already answered', 'Forbidden repository', 'private question']) {
      assert.doesNotMatch(listedText, new RegExp(hidden), `${hidden} must not be listed`);
    }

    // Repository filtering and paging are bounded.
    assert.deepEqual((await call('list_goal_attention', { repository: otherRepository })).goals.map((entry: Json) => entry.goalId), [approvalGoalId]);
    const firstPage = await call('list_goal_attention', { limit: 1 });
    assert.equal(firstPage.goals.length, 1);
    assert.equal(firstPage.nextOffset, 1);
    await assert.rejects(call('list_goal_attention', { repository: forbiddenRepository }), /Denied|forbidden|REPOSITORY/i);

    // get_goal reads the same projection.
    const detail = await call('get_goal', { repository, goalId: questionGoalId });
    assert.deepEqual(detail.goal.attention, { waitingForOperator: true, reason: 'provider_question', blockers: question.blockers });
    assert.equal(detail.pendingInput.waitingForOperator, true);
    assert.equal(detail.pendingInput.reason, 'provider_question');
    const stale = await call('get_goal', { repository, goalId: staleGoalId });
    assert.deepEqual(stale.goal.attention, { waitingForOperator: false, reason: null, blockers: [] });
    const quiet = await call('get_goal', { repository, goalId: quietGoalId });
    assert.equal(quiet.pendingInput.waitingForOperator, false, 'queued corrections are not a blocker');
    assert.equal(quiet.pendingInput.undeliveredInputs, 1);
    const resuming = await call('get_goal', { repository, goalId: resumingGoalId });
    assert.equal(resuming.pendingInput.waitingForOperator, false, 'a queued resume no longer waits for a pause response');

    // The activity digest reports the same blockers with the same available actions.
    const activity = await call('get_current_activity', {});
    const goalBlockers = activity.sections.blockers.items.filter((item: Json) => item.kind === 'goal');
    const digestByGoal = new Map<string, Json>(goalBlockers.map((item: Json) => [item.reference.goalId, item]));
    assert.deepEqual([...digestByGoal.keys()].sort(), [questionGoalId, pausedGoalId, approvalGoalId].sort());
    assert.match(digestByGoal.get(questionGoalId)!.summary, /Goal asked a question/);
    assert.deepEqual(digestByGoal.get(questionGoalId)!.goalBlocker,
      { id: question.blockers[0].id, category: 'question', actionable: true, responseActions: ['send_input', 'pause', 'cancel'] });
    assert.match(digestByGoal.get(pausedGoalId)!.summary, /Goal paused, awaiting input/);

    // REST listing used by the CLI and the goal console projection agree; a stranger sees only their own.
    const routes = createGoalRoutes({ db, redisClient, taskQueue: {} as never, ...goalServices } as never);
    const respond = async (handler: (req: never, res: never) => Promise<void>, user: string, query: Record<string, string> = {}, params: Record<string, string> = {}) => {
      let body: Json = {};
      let status = 200;
      const res = { status(code: number) { status = code; return res; }, json(value: Json) { body = value; return res; } };
      await handler({ user: { id: user }, query, params, get: () => undefined } as never, res as never);
      return { status, body };
    };
    const rest = await respond(routes.attention as never, ownerId, { repository });
    assert.equal(rest.status, 200);
    assert.deepEqual(rest.body.goals.map((entry: Json) => entry.goalId).sort(), [questionGoalId, pausedGoalId].sort());
    assert.deepEqual(rest.body.goals.find((entry: Json) => entry.goalId === questionGoalId).blockers, question.blockers);
    const strangerRest = await respond(routes.attention as never, strangerId);
    assert.deepEqual(strangerRest.body.goals.map((entry: Json) => entry.goalId), [strangerGoalId]);
    assert.equal((await respond(routes.attention as never, ownerId, { repository: 'not a repo' })).status, 400);
    const consoleRead = await respond(routes.get as never, ownerId, {}, { goalId: questionGoalId });
    assert.deepEqual(consoleRead.body.goal.attention, detail.goal.attention);
    assert.equal((await respond(routes.get as never, strangerId, {}, { goalId: questionGoalId })).status, 404);

    // Dashboard attention lists one item per blocker, owner-scoped and repository-filtered.
    const work = await loadDashboardWork(db, repository, { ownerId });
    const items = work.attention.filter(item => item.kind === 'goal_blocker');
    assert.deepEqual(items.map(item => item.goalId).sort(), [questionGoalId, pausedGoalId].sort());
    const dashboardQuestion = items.find(item => item.goalId === questionGoalId)!;
    assert.equal(dashboardQuestion.id, `goal-blocker:${question.blockers[0].id}`);
    assert.equal(dashboardQuestion.detail, question.blockers[0].summary);
    assert.deepEqual(dashboardQuestion.goalBlocker!.responseActions, question.blockers[0].responseActions);
    assert.equal(work.counts.needsAttention, work.attention.length);
    assert.deepEqual((await loadDashboardWork(db, repository, {})).attention.filter(item => item.kind === 'goal_blocker'), [],
      'goals are never listed without an owner');
  } finally {
    boundary.restore();
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});
