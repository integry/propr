import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express, { type Express, type RequestHandler } from 'express';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { createAdminMcpRoutes } from '../routes/adminMcpRoutes.js';
import type { McpAccessLogRow } from '../mcp/accessLog.js';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';
import type { Args, CommentFixture, PullRequestFixture } from './fixtures/mcpPullRequestWrites.js';
import {
  at, configuredRepositories, createActivityDatabase, insertGoal, insertHistory, insertTask,
  owner, repositories,
} from './fixtures/mcpActivity.js';

/**
 * End-to-end regression for the MCP operator surface this epic delivers, exercised
 * through the real tool catalog in one session: "what is happening now?" → the goal
 * and task behind it → their pull request → a correction, a model change and the
 * ultrafix breaker → the access log an operator reads afterwards.
 *
 * Only the outbound GitHub boundary, the configured repository list and the agent
 * registry are fixtures. The catalog, schemas, authorization, persistence and access
 * recording are the shipped code. No live GitHub, no provider credits, no real merge.
 */

const repository = 'acme/web';
const forbiddenRepository = 'acme/forbidden';
const goalId = '11111111-1111-4111-8111-111111111111';
const goalTaskId = 'goal-task-1';
const childTaskId = 'task-42';
const PULL_REQUEST = 42;
const HEAD = 'a'.repeat(40);
const LABEL_PAGE = 100;

const agentConfigs = [
  { id: 'claude-agent', alias: 'claude', type: 'claude', enabled: true, supportedModels: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-opus-5' },
  { id: 'codex-agent', alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-5.6'], defaultModel: 'gpt-5.6' },
];

const core = await import('@propr/core');
const coreMock = await mock.module('@propr/core', {
  namedExports: {
    ...core,
    loadMonitoredReposRaw: async () => configuredRepositories.current,
    loadAgents: async () => agentConfigs,
    loadSyntheticAgents: async () => [],
  },
});
after(async () => { coreMock.restore(); await core.closeConnection(); });

const { McpError } = await import('../mcp/config.js');
const { McpPolicy } = await import('../mcp/policy.js');
const { McpStore } = await import('../mcp/store.js');
const { McpOAuthProvider } = await import('../mcp/oauth.js');
const { createToolCatalog, executeTool } = await import('../mcp/tools.js');

interface AccessExpectation {
  kind: string; name: string; repository: string | null; scope: string;
  readOnly: boolean; outcome: string; errorCode: string | null; status: number;
}

const accessRows = (db: Knex) => db<McpAccessLogRow>('mcp_access_log').orderBy('id').select('*');

function projectAccessRow(row: McpAccessLogRow): AccessExpectation {
  return {
    kind: row.kind, name: row.name, repository: row.repository, scope: row.scope as string,
    readOnly: Boolean(row.read_only), outcome: row.outcome, errorCode: row.error_code, status: Number(row.status),
  };
}

async function withServer(app: Express, run: (origin: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

/** The admin read API behind the MCP Log, mounted exactly as the route registry does. */
function adminApp(db: Knex): Express {
  const routes = createAdminMcpRoutes({ database: db });
  const app = express();
  app.get('/api/admin/mcp/logs', routes.getLogs as RequestHandler);
  app.get('/api/admin/mcp/logs/stats', routes.getLogStats as RequestHandler);
  return app;
}

async function seed(db: Knex): Promise<void> {
  // A goal running in the grant, its private goal task, and the ordinary task that
  // opened the pull request this session acts on.
  await insertGoal(db, {
    goal_id: goalId, repository, title: 'Harden retry handling', objective: 'Harden retry handling',
    current_task_id: goalTaskId, final_pr_number: PULL_REQUEST, agent_alias: 'claude',
    requested_model: 'claude-sonnet-5', effective_model: 'claude-sonnet-5', artifact_refs: '[]', artifact_stats: '{}',
    created_at: at(3_600_000), updated_at: at(60_000), started_at: at(3_600_000),
  });
  await insertTask(db, { taskId: goalTaskId, repository, createdAt: at(3_600_000), taskType: 'goal' });
  await insertHistory(db, { taskId: goalTaskId, state: 'claude_execution', timestamp: at(120_000) });
  await insertTask(db, {
    taskId: childTaskId, repository, createdAt: at(3_000_000), issueNumber: 88, prNumber: PULL_REQUEST,
    job: { title: 'Retry transient GitHub failures', agentAlias: 'claude' },
  });
  await insertHistory(db, { taskId: childTaskId, state: 'processing', timestamp: at(2_900_000), reason: 'Started work' });
  await insertHistory(db, { taskId: childTaskId, state: 'claude_execution', timestamp: at(180_000), reason: 'Rewriting the retry path' });
  await db('tasks').where({ task_id: childTaskId }).update({ correlation_id: goalId, model_name: 'claude-sonnet-5' });
  // Work in a repository the credential can no longer read, so the denial below is real.
  await insertTask(db, { taskId: 'forbidden-task', repository: forbiddenRepository, createdAt: at(3_600_000) });
  await insertHistory(db, { taskId: 'forbidden-task', state: 'claude_execution', timestamp: at(120_000) });
}

test('the MCP operator surface answers what is happening, drills in, acts on the pull request and records every call', async t => {
  const db = await createActivityDatabase();
  t.after(() => db.destroy());
  repositories(repository, forbiddenRepository);
  await seed(db);

  const pullRequests: PullRequestFixture[] = [
    { repository, number: PULL_REQUEST, state: 'OPEN', merged: false, title: 'Retry transient GitHub failures', head: HEAD,
      createdAt: at(3_000_000), updatedAt: at(120_000), labels: ['llm-claude-sonnet-5', 'ultrafix'], reviewDecision: null, checks: 'PENDING' },
    { repository, number: 41, state: 'MERGED', merged: true, title: 'Persist receipts', head: 'b'.repeat(40),
      createdAt: at(86_400_000), updatedAt: at(80_000_000), labels: [], reviewDecision: 'APPROVED', checks: 'SUCCESS' },
    { repository: forbiddenRepository, number: 9, state: 'OPEN', merged: false, title: 'Never read', head: 'c'.repeat(40),
      createdAt: at(3_600_000), updatedAt: at(600_000), labels: [], reviewDecision: null, checks: null },
  ];
  // A real published ProPR review: the public comment contract the F# parser reads.
  const reviewBody = [
    `<!-- propr:ai-review head="${HEAD}" -->`,
    '## Overall Evaluation',
    'Retries are bounded, but one transient status is still fatal.',
    '## Merge blockers',
    'Every finding below was introduced by this PR and must be resolved before merging.',
    '### F1: 🔴 Retry the 502 response',
    '- **Required behavior:** A 502 from GitHub must be retried like the other transient statuses.',
    '- **Evidence:** src/retry.ts only lists 500 and 503.',
    '- **Minimum fix:** Add 502 to the retried status list.',
    '## Suggestions',
    'These are optional follow-ups and are not sent to `/fix`.',
    'No suggestions.',
    '## Score',
    'Score: 7/10',
  ].join('\n');
  const comments: CommentFixture[] = [
    { id: 101, repository, pullRequest: PULL_REQUEST, body: 'Opening this for review.', createdAt: at(2_000_000), author: 'fixture-user' },
    { id: 102, repository, pullRequest: PULL_REQUEST, body: reviewBody, createdAt: at(900_000), author: 'propr-dev[bot]' },
  ];
  const repositoryLabels = new Map<string, string[]>([
    [repository, ['llm-claude-opus-5', 'llm-claude-sonnet-5', 'ultrafix', 'AI']],
  ]);
  const restCalls: Array<{ route: string; args: Args }> = [];
  const graphqlCalls: Args[] = [];
  const findPullRequest = (name: string, number: number): PullRequestFixture => {
    const pull = pullRequests.find(item => item.repository === name && item.number === number);
    if (!pull) throw Object.assign(new Error('Not Found'), { status: 404 });
    return pull;
  };
  const orderedComments = (name: string, number: number) => comments
    .filter(comment => comment.repository === name && comment.pullRequest === number)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  const github = {
    graphql: async (query: string, args: Args) => {
      graphqlCalls.push({ query, ...args });
      const name = `${args.owner}/${args.repo}`;
      if (query.includes('comments(last:')) {
        const ordered = orderedComments(name, Number(args.number));
        const end = args.before === null || args.before === undefined ? ordered.length : Number(args.before);
        const start = Math.max(0, end - Number(args.last));
        return { repository: { pullRequest: { comments: {
          pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
          nodes: ordered.slice(start, end).map(comment => ({
            databaseId: comment.id, body: comment.body, createdAt: comment.createdAt,
            url: `https://github.com/${name}/pull/${comment.pullRequest}#issuecomment-${comment.id}`,
            author: { login: comment.author },
          })),
        } } } };
      }
      const field = args.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
      const matching = pullRequests.filter(pull => pull.repository === name)
        .filter(pull => !args.states || (args.states as string[]).includes(pull.state))
        .sort((left, right) => Date.parse(right[field]) - Date.parse(left[field]));
      return { repository: { pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: String(matching.length) },
        nodes: matching.map(pull => ({
          number: pull.number, title: pull.title, state: pull.state, isDraft: false, merged: pull.merged,
          createdAt: pull.createdAt, updatedAt: pull.updatedAt, url: `https://github.com/${pull.repository}/pull/${pull.number}`,
          headRefOid: pull.head, baseRefName: 'main', reviewDecision: pull.reviewDecision, author: { login: 'fixture-user' },
          labels: { pageInfo: { hasNextPage: pull.labels.length > LABEL_PAGE }, nodes: pull.labels.slice(0, LABEL_PAGE).map(label => ({ name: label })) },
          commits: { nodes: [{ commit: { statusCheckRollup: pull.checks ? { state: pull.checks } : null } }] },
        })),
      } } };
    },
    request: async (route: string, args: Args) => {
      restCalls.push({ route, args });
      const name = `${args.owner}/${args.repo}`;
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        const pull = findPullRequest(name, Number(args.pull_number));
        return { data: { number: pull.number, title: pull.title, body: 'Fixture body', state: pull.state === 'OPEN' ? 'open' : 'closed',
          draft: false, merged: pull.merged, head: { sha: pull.head }, base: { ref: 'main' },
          labels: pull.labels.map(label => ({ name: label })), html_url: `https://github.com/${name}/pull/${pull.number}` } };
      }
      if (route === 'GET /repos/{owner}/{repo}/labels') {
        const all = repositoryLabels.get(name) ?? [];
        const perPage = Number(args.per_page ?? 30);
        const page = Number(args.page ?? 1);
        return { data: all.slice((page - 1) * perPage, page * perPage).map(label => ({ name: label })) };
      }
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        const comment = { id: 900 + comments.length, repository: name, pullRequest: Number(args.issue_number),
          body: String(args.body), createdAt: new Date().toISOString(), author: 'fixture-user' };
        comments.push(comment);
        return { data: { id: comment.id, html_url: `https://github.com/${name}/pull/${comment.pullRequest}#issuecomment-${comment.id}` } };
      }
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
        const pull = findPullRequest(name, Number(args.issue_number));
        pull.labels.push(...(args.labels as string[]));
        return { data: pull.labels.map(label => ({ name: label })) };
      }
      if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
        const pull = findPullRequest(name, Number(args.issue_number));
        pull.labels = pull.labels.filter(label => label !== args.name);
        return { data: pull.labels.map(label => ({ name: label })) };
      }
      throw new Error(`Unexpected GitHub fixture request: ${route}`);
    },
  };

  const registry = core.AgentRegistry.getInstance();
  const registryAgents = agentConfigs.map(config => ({ config }));
  const stubs = [
    mock.method(registry, 'ensureInitialized', async () => {}),
    mock.method(registry, 'getAllAgents', () => registryAgents as never),
    mock.method(registry, 'getDefaultAgent', () => registryAgents[0] as never),
    mock.method(registry, 'getAgentByAlias', (alias: string) => registryAgents.find(agent => agent.config.alias === alias) as never),
  ];
  t.after(() => { for (const stub of stubs) stub.mock.restore(); });

  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp',
    instanceId: 'operator-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  // The credential lost access to one granted repository; every other authorization
  // check, including scopes, stays the shipped implementation.
  policy.repository = async (_principal, target) => {
    if (target === forbiddenRepository) throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403);
  };
  const redisClient = { get: async () => null, sMembers: async () => [] } as unknown as RedisClientType;
  const deps: ToolDeps = { db, policy, redisClient, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    goalServices: { loadVisualPreviewSettings: async () => ({ enabled: false, types: ['image'] }),
      processAttachments: async () => [], uploadIdentity: async () => [],
      stopExecution: async () => ({ success: true, containerStopped: true, removedQueuedJobs: 0 }) as never } };
  const catalog = createToolCatalog(deps);
  const scopes = ['read', 'execute', 'review'] as const;
  const principal = {
    user: { id: owner, username: 'tester', login: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture-github' },
    authorization: { role: 'member', source: 'local', permissions: [] },
    scopes: [...scopes], github,
    grant: { id: 'operator-grant', ownerId: owner, clientId: 'claude-desktop', clientName: 'Claude', instanceId: config.instanceId,
      resource: config.resource, scopes: [...scopes], repositories: [repository, forbiddenRepository],
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
  } as unknown as McpPrincipal;

  const tool = (name: string): McpTool => {
    const found = catalog.find(candidate => candidate.name === name);
    assert.ok(found, `${name} is missing from the catalog`);
    return found;
  };
  let sequence = 0;
  const call = async (name: string, args: Args = {}, actor: McpPrincipal = principal): Promise<Args> =>
    (await executeTool(tool(name), args, actor, deps)).data as Args;
  const mutate = async (name: string, args: Args, actor: McpPrincipal = principal): Promise<Args> =>
    call(name, { ...args, idempotencyKey: `operator-surface-${sequence++}` }, actor);

  const expected: AccessExpectation[] = [];
  const expect = (row: Partial<AccessExpectation> & Pick<AccessExpectation, 'name' | 'scope'>): void => {
    expected.push({ kind: 'tool', repository: null, readOnly: true, outcome: 'success', errorCode: null, status: 200, ...row });
  };

  let runningGoal: Args;
  let runningTask: Args;

  await t.test('get_current_activity answers what is happening now across the grant', async () => {
    const digest = await call('get_current_activity');
    expect({ name: 'get_current_activity', scope: 'read' });
    // The repository the credential can no longer read is skipped, not failed.
    assert.deepEqual(digest.repositories, [repository]);
    assert.equal(digest.repositoriesTruncated, false);
    assert.doesNotMatch(JSON.stringify(digest), /forbidden/);

    runningGoal = digest.sections.activeGoals.items[0];
    assert.equal(digest.sections.activeGoals.count, 1);
    assert.equal(runningGoal.goalId, goalId);
    assert.equal(runningGoal.repository, repository);
    assert.deepEqual(digest.sections.runningTasks.items.map((task: Args) => task.taskId).sort(), [goalTaskId, childTaskId].sort());
    runningTask = digest.sections.runningTasks.items.find((task: Args) => task.taskId === childTaskId);
    assert.equal(runningTask.prNumber, PULL_REQUEST);
  });

  await t.test('the running item drills into enriched goal and task detail', async () => {
    const goal = await call('get_goal', { repository, goalId: runningGoal.goalId });
    expect({ name: 'get_goal', repository, scope: 'read' });
    assert.equal(goal.goal.id, goalId);
    assert.deepEqual(goal.progress.tasks, { total: 2, active: 2, completed: 0, failed: 0, cancelled: 0 });
    assert.equal(goal.pendingInput.waitingForOperator, false);
    // The goal's final pull request and its task's pull request are the same one.
    assert.deepEqual(goal.pullRequests, [{ number: PULL_REQUEST, state: null, role: 'final' }]);

    const task = await call('get_task', { repository, taskId: runningTask.taskId });
    expect({ name: 'get_task', repository, scope: 'read' });
    assert.equal(task.task_id, childTaskId);
    assert.equal(task.latestEvent.state, 'claude_execution');
    assert.deepEqual(task.latestEvents.map((event: Args) => event.state), ['claude_execution', 'processing']);
    assert.equal(task.pullRequest.number, PULL_REQUEST);
    assert.equal(task.changesSummary, null, 'unpersisted file changes never read as zero changes');
  });

  await t.test('the pull request inventory correlates that work back to its goal and task', async () => {
    const listed = await call('list_pull_requests', { includeLatestComment: true });
    expect({ name: 'list_pull_requests', scope: 'read' });
    assert.deepEqual(listed.repositories, [repository]);
    const pull = listed.pullRequests.find((item: Args) => item.number === PULL_REQUEST);
    assert.equal(pull.head, HEAD);
    assert.equal(pull.propr.goalId, goalId);
    assert.equal(pull.propr.taskId, childTaskId);
    assert.equal(pull.propr.issueNumber, 88);
    assert.equal(pull.propr.ultrafixActive, true);
    assert.equal(pull.latestComment.isProprReview, true);
    assert.ok(!graphqlCalls.some(args => `${args.owner}/${args.repo}` === forbiddenRepository));

    const discussion = await call('get_pull_request_discussion', { repository, pullRequest: PULL_REQUEST, order: 'newest' });
    expect({ name: 'get_pull_request_discussion', repository, scope: 'read' });
    assert.equal(discussion.head, HEAD);
    assert.deepEqual(discussion.comments.map((comment: Args) => comment.id), [102, 101]);
    assert.deepEqual(discussion.comments[0].review.currentFindingIds, ['F1']);
  });

  await t.test('a correction, a model change and the ultrafix breaker act on the same head', async () => {
    const pull = { repository, pullRequest: PULL_REQUEST, expectedHead: HEAD };
    const posted = await mutate('comment_on_pull_request', { ...pull, message: 'Also cover the 502 retry path before merging.' });
    expect({ name: 'comment_on_pull_request', repository, scope: 'execute', readOnly: false });
    assert.equal(posted.state, 'posted');
    assert.ok(comments.some(comment => comment.id === posted.result.commentId));

    const routed = await mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' });
    expect({ name: 'set_pull_request_model', repository, scope: 'execute', readOnly: false });
    assert.equal(routed.state, 'completed');
    assert.equal(routed.result.label, 'llm-claude-opus-5');
    assert.deepEqual(routed.result.removedLabels, ['llm-claude-sonnet-5']);
    assert.deepEqual(findPullRequest(repository, PULL_REQUEST).labels.filter(label => label.startsWith('llm-')), ['llm-claude-opus-5']);

    // Clearing the breaker is a review-scoped de-escalation; without that scope it is denied.
    const withoutReview = { ...principal, scopes: principal.scopes.filter(scope => scope !== 'review') } as McpPrincipal;
    const refused = await mutate('stop_ultrafix', pull, withoutReview);
    expect({ name: 'stop_ultrafix', repository, scope: 'execute', readOnly: false,
      outcome: 'denied', errorCode: 'INSUFFICIENT_SCOPE', status: 403 });
    assert.equal(refused.state, 'failed');
    assert.equal(refused.result.error.code, 'INSUFFICIENT_SCOPE');
    assert.ok(findPullRequest(repository, PULL_REQUEST).labels.includes('ultrafix'));

    const stopped = await mutate('stop_ultrafix', pull);
    expect({ name: 'stop_ultrafix', repository, scope: 'execute', readOnly: false });
    assert.equal(stopped.result.wasActive, true);
    assert.equal(stopped.result.circuitBreaker, 'cleared');
    // Acceptance is not proof of stopping: a cycle already running may still finish.
    assert.ok(stopped.result.message.includes('may still finish'));
    assert.ok(!findPullRequest(repository, PULL_REQUEST).labels.includes('ultrafix'));
  });

  await t.test('a repository the credential cannot read is denied, not silently listed', async () => {
    await assert.rejects(call('list_pull_requests', { repository: forbiddenRepository }),
      (error: unknown) => error instanceof McpError && error.status === 403);
    expect({ name: 'list_pull_requests', repository: forbiddenRepository, scope: 'read',
      outcome: 'denied', errorCode: 'REPOSITORY_FORBIDDEN', status: 403 });
  });

  await t.test('the access log recorded every invocation in this session with its outcome', async () => {
    const recorded = await accessRows(db);
    assert.deepEqual(recorded.map(projectAccessRow), expected);
    for (const row of recorded) {
      assert.equal(row.owner_id, owner);
      assert.equal(row.grant_id, 'operator-grant');
      assert.equal(row.client_id, 'claude-desktop');
      assert.equal(row.client_name, 'Claude');
      assert.equal(row.membership_source, 'local');
      assert.ok(Number(row.duration_ms) >= 0);
    }
    // Every mutation carries the durable receipt handle; reads carry none.
    for (const row of recorded) {
      if (row.read_only) assert.equal(row.operation_id, null, `${row.name} read carries no operation handle`);
      else assert.ok(row.operation_id, `${row.name} mutation carries its operation handle`);
    }
    // The log deliberately stores no argument or payload content.
    const serialized = JSON.stringify(recorded);
    for (const secret of ['502 retry path', 'Harden retry handling', 'Retry transient GitHub failures',
      'fixture-github', 'operator-surface-']) {
      assert.ok(!serialized.includes(secret), `access log never stores ${secret}`);
    }
  });

  await t.test('an operator reads that session back through the admin MCP log API', async () => {
    await withServer(adminApp(db), async origin => {
      const get = async (query: string) => {
        const response = await fetch(`${origin}/api/admin/mcp/logs${query}`);
        return await response.json() as { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
      };
      const all = await get('');
      // The API pages newest-first, so the session reads back in reverse.
      assert.deepEqual(all.data.map(row => row.name), [...expected].reverse().map(row => row.name));
      assert.equal(all.pagination.total, expected.length);

      const denials = await get('?outcome=denied');
      assert.deepEqual(denials.data.map(row => row.name), ['list_pull_requests', 'stop_ultrafix']);
      assert.deepEqual(denials.data.map(row => row.errorCode), ['REPOSITORY_FORBIDDEN', 'INSUFFICIENT_SCOPE']);

      const scoped = await get(`?repository=${encodeURIComponent(repository)}&outcome=success`);
      assert.deepEqual(scoped.data.map(row => row.name),
        ['stop_ultrafix', 'set_pull_request_model', 'comment_on_pull_request', 'get_pull_request_discussion', 'get_task', 'get_goal']);

      const stats = await fetch(`${origin}/api/admin/mcp/logs/stats`);
      const summary = await stats.json() as { data: { total: number; outcomes: Record<string, number> } };
      assert.equal(summary.data.total, expected.length);
      assert.deepEqual(summary.data.outcomes, {
        success: expected.filter(row => row.outcome === 'success').length,
        denied: expected.filter(row => row.outcome === 'denied').length,
        error: 0,
      });
    });
  });
});
