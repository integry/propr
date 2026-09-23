import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';

interface PullRequestFixture {
  repository: string; number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; merged: boolean;
  title: string; head: string; createdAt: string; updatedAt: string; labels: string[];
  reviewDecision: string | null; checks: string | null;
}
interface CommentFixture { id: number; pullRequest: number; repository: string; body: string; createdAt: string; author: string }
type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

test('the MCP pull request surface lists, correlates, comments, routes models and clears the ultrafix breaker', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-pulls-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { McpError } = await import('../mcp/config.js');
  const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
  const { db } = core;

  // Only the outbound GitHub boundary is a fixture. Catalog, schemas, authorization,
  // label convergence, model resolution and persistence remain the real code.
  const pullRequests: PullRequestFixture[] = [
    { repository: 'acme/repo', number: 42, state: 'OPEN', merged: false, title: 'Improve reliability', head: 'a'.repeat(40),
      createdAt: minutesAgo(10), updatedAt: minutesAgo(5), labels: ['llm-claude-sonnet-5', 'ultrafix', 'auto-merge'], reviewDecision: 'APPROVED', checks: 'SUCCESS' },
    { repository: 'acme/repo', number: 41, state: 'MERGED', merged: true, title: 'Persist receipts', head: 'b'.repeat(40),
      createdAt: minutesAgo(4320), updatedAt: minutesAgo(2880), labels: [], reviewDecision: 'APPROVED', checks: 'SUCCESS' },
    { repository: 'acme/repo', number: 40, state: 'CLOSED', merged: false, title: 'Abandoned attempt', head: 'c'.repeat(40),
      createdAt: minutesAgo(8640), updatedAt: minutesAgo(8640), labels: [], reviewDecision: null, checks: null },
    { repository: 'acme/other', number: 7, state: 'OPEN', merged: false, title: 'Bound the inventory', head: 'd'.repeat(40),
      createdAt: minutesAgo(30), updatedAt: minutesAgo(1), labels: ['llm-claude-opus-5'], reviewDecision: null, checks: 'PENDING' },
    { repository: 'acme/other', number: 6, state: 'OPEN', merged: false, title: 'Stale proposal', head: 'e'.repeat(40),
      createdAt: minutesAgo(28800), updatedAt: minutesAgo(28800), labels: [], reviewDecision: null, checks: null },
    ...Array.from({ length: 12 }, (_, index) => ({
      repository: 'acme/bulk', number: 100 + index, state: 'OPEN' as const, merged: false, title: `Bulk ${index}`,
      head: String(index).padStart(40, 'f'), createdAt: minutesAgo(1440 + index), updatedAt: minutesAgo(1440 + index),
      labels: [] as string[], reviewDecision: null, checks: null,
    })),
  ];
  const repositoryLabels = new Map<string, string[]>([
    ['acme/repo', ['llm-claude-opus-5', 'llm-claude-sonnet-5', 'ultrafix', 'auto-merge', 'AI']],
    ['acme/other', ['llm-claude-opus-5']],
    ['acme/bulk', []],
  ]);
  const longBody = `Latest thought ${'detail '.repeat(120)}`;
  const reviewBody = `<!-- propr:ai-review head="${'a'.repeat(40)}" -->\n## Overall Evaluation\nLooks fine.\n\n## Score\nScore: 8/10`;
  const comments: CommentFixture[] = [
    { id: 101, repository: 'acme/repo', pullRequest: 42, body: 'First look', createdAt: minutesAgo(60), author: 'fixture-user' },
    { id: 102, repository: 'acme/repo', pullRequest: 42, body: reviewBody, createdAt: minutesAgo(30), author: 'propr-dev[bot]' },
    { id: 103, repository: 'acme/repo', pullRequest: 42, body: longBody, createdAt: minutesAgo(10), author: 'fixture-user' },
    { id: 201, repository: 'acme/other', pullRequest: 7, body: reviewBody, createdAt: minutesAgo(20), author: 'propr-dev[bot]' },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: 300 + index, repository: 'acme/bulk', pullRequest: 100 + index, body: `Bulk comment ${index}`,
      createdAt: minutesAgo(100 + index), author: 'fixture-user',
    })),
  ];

  const graphqlCalls: Args[] = [];
  const restCalls: Array<{ route: string; args: Args }> = [];
  const denied = new Set(['acme/forbidden']);
  const findPullRequest = (repository: string, number: number) => {
    const pull = pullRequests.find(item => item.repository === repository && item.number === number);
    if (!pull) throw Object.assign(new Error('Not Found'), { status: 404 });
    return pull;
  };
  const restPullRequest = (pull: PullRequestFixture) => ({
    number: pull.number, title: pull.title, body: 'Fixture body', state: pull.state === 'OPEN' ? 'open' : 'closed',
    draft: false, merged: pull.merged, head: { sha: pull.head }, base: { ref: 'main' },
    labels: pull.labels.map(name => ({ name })), html_url: `https://github.com/${pull.repository}/pull/${pull.number}`,
  });
  const listComments = (repository: string, pullRequest: number, args: Args) => {
    const ordered = comments.filter(comment => comment.repository === repository && comment.pullRequest === pullRequest)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    if (args.direction === 'desc') ordered.reverse();
    const perPage = Number(args.per_page ?? 30);
    const page = Number(args.page ?? 1);
    return ordered.slice((page - 1) * perPage, page * perPage).map(comment => ({
      id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: comment.author },
      html_url: `https://github.com/${repository}/pull/${pullRequest}#issuecomment-${comment.id}`,
      issue_url: `https://api.github.com/repos/${repository}/issues/${pullRequest}`,
    }));
  };
  const github = {
    graphql: async (_query: string, args: Args) => {
      graphqlCalls.push(args);
      const repository = `${args.owner}/${args.repo}`;
      const field = args.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
      const matching = pullRequests.filter(pull => pull.repository === repository)
        .filter(pull => !args.states || args.states.includes(pull.state))
        .sort((left, right) => Date.parse(right[field]) - Date.parse(left[field]));
      const start = args.after ? Number(args.after) : 0;
      const nodes = matching.slice(start, start + Number(args.first));
      return { repository: { pullRequests: {
        pageInfo: { hasNextPage: start + nodes.length < matching.length, endCursor: String(start + nodes.length) },
        nodes: nodes.map(pull => ({
          number: pull.number, title: pull.title, state: pull.state, isDraft: false, merged: pull.merged,
          createdAt: pull.createdAt, updatedAt: pull.updatedAt, url: `https://github.com/${pull.repository}/pull/${pull.number}`,
          headRefOid: pull.head, baseRefName: 'main', reviewDecision: pull.reviewDecision, author: { login: 'fixture-user' },
          labels: { nodes: pull.labels.map(name => ({ name })) },
          commits: { nodes: [{ commit: { statusCheckRollup: pull.checks ? { state: pull.checks } : null } }] },
        })),
      } } };
    },
    request: async (route: string, args: Args) => {
      restCalls.push({ route, args });
      const repository = `${args.owner}/${args.repo}`;
      if (route === 'GET /repos/{owner}/{repo}') {
        if (denied.has(repository)) throw Object.assign(new Error('Forbidden'), { status: 403 });
        return { data: { permissions: { push: true } } };
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: restPullRequest(findPullRequest(repository, Number(args.pull_number))) };
      if (route.endsWith('/reviews')) return { data: [{ id: 1, state: 'APPROVED', body: 'Reviewed', commit_id: findPullRequest(repository, Number(args.pull_number)).head }] };
      if (route.endsWith('/check-runs')) return { data: { check_runs: [{ name: 'tests', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/repo/runs/1' }] } };
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return { data: listComments(repository, Number(args.issue_number), args) };
      if (route === 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}') {
        const comment = comments.find(item => item.id === Number(args.comment_id))!;
        return { data: listComments(comment.repository, comment.pullRequest, { per_page: 100, page: 1 }).find(item => item.id === comment.id)! };
      }
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        const comment = { id: 900 + comments.length, repository, pullRequest: Number(args.issue_number), body: String(args.body), createdAt: new Date().toISOString(), author: 'fixture-user' };
        comments.push(comment);
        return { data: { id: comment.id, html_url: `https://github.com/${repository}/pull/${comment.pullRequest}#issuecomment-${comment.id}` } };
      }
      if (route === 'GET /repos/{owner}/{repo}/labels') return { data: (repositoryLabels.get(repository) ?? []).map(name => ({ name })) };
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
        const pull = findPullRequest(repository, Number(args.issue_number));
        pull.labels.push(...(args.labels as string[]));
        return { data: pull.labels.map(name => ({ name })) };
      }
      if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
        const pull = findPullRequest(repository, Number(args.issue_number));
        pull.labels = pull.labels.filter(name => name !== args.name);
        return { data: pull.labels.map(name => ({ name })) };
      }
      throw new Error(`Unexpected GitHub fixture request: ${route}`);
    },
  };

  const registry = core.AgentRegistry.getInstance();
  const agents = [
    { config: { id: 'claude-agent', alias: 'claude', type: 'claude', enabled: true, supportedModels: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-opus-5' } },
    { config: { id: 'codex-agent', alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-5.6'], defaultModel: 'gpt-5.6' } },
    { config: { id: 'legacy-agent', alias: 'legacy', type: 'claude', enabled: false, supportedModels: ['claude-haiku-4-5'], defaultModel: 'claude-haiku-4-5' } },
  ];
  const stubs = [
    mock.method(registry, 'ensureInitialized', async () => {}),
    mock.method(registry, 'getAllAgents', () => agents as never),
    mock.method(registry, 'getDefaultAgent', () => agents[0] as never),
    mock.method(registry, 'getAgentByAlias', (alias: string) => agents.find(agent => agent.config.alias === alias) as never),
  ];

  try {
    await core.runMigrations();
    await core.saveAgents(agents.map(agent => agent.config) as never);
    await core.saveMonitoredRepos([
      { id: randomUUID(), name: 'acme/repo', enabled: true, baseBranch: 'main' },
      { id: randomUUID(), name: 'acme/other', enabled: true, baseBranch: 'main' },
      { id: randomUUID(), name: 'acme/bulk', enabled: true, baseBranch: 'main' },
      { id: randomUUID(), name: 'acme/disabled', enabled: false, baseBranch: 'main' },
      { id: randomUUID(), name: 'acme/forbidden', enabled: true, baseBranch: 'main' },
      { id: randomUUID(), name: 'acme/ungranted', enabled: true, baseBranch: 'main' },
    ] as never);

    // ProPR's own records for the correlation block.
    await db('tasks').insert({ task_id: 'task-42', repository: 'acme/repo', issue_number: 88, task_type: 'issue',
      model_name: 'claude-opus-5', pr_number: 42, initial_job_data: JSON.stringify({ agentAlias: 'claude' }) });
    await db('task_drafts').insert({ draft_id: 'plan-1', user_id: '123', repository: 'acme/repo', mcp_revision: 0 });
    await db('plan_issues').insert({ draft_id: 'plan-1', repository: 'acme/repo', issue_number: 88, pr_number: 42,
      status: 'under_review', agent_alias: 'claude', model_name: 'claude-opus-5', task_id: 'task-42' });
    await db('goals').insert({ goal_id: 'goal-1', owner_id: '123', owner_login: 'fixture-user', repository: 'acme/other',
      objective: 'Bound the inventory', desired_state: 'running', launch_strategy: 'direct', initial_prompt: 'Bound it',
      agent_id: 'codex-agent', agent_alias: 'codex', agent_type: 'codex', requested_model: 'gpt-5.6', effective_model: 'gpt-5.6',
      current_task_id: 'goal-task-1', final_pr_number: 7 });
    // GitHub still reports #40 as closed; ProPR's merge record is authoritative.
    await db('notification_pull_request_state').insert({ repository: 'acme/repo', pr_number: 40, merged_at: new Date(NOW).toISOString() });

    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
    const deps: ToolDeps = { db, policy, taskQueue: {} as never, runtimeBuildQueue: {} as never,
      redisClient: { get: async () => null, sMembers: async () => [] } as never };
    const catalog = createToolCatalog(deps);
    const scopes = ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'manage'] as const;
    const grantedRepositories = ['acme/repo', 'acme/other', 'acme/bulk', 'acme/disabled', 'acme/forbidden'];
    const principal = { user: { id: '123', username: 'fixture-user', login: 'fixture-user', displayName: 'Fixture user', email: null, avatarUrl: null, accessToken: 'fixture-github' },
      authorization: { role: 'admin', source: 'local', permissions: [] }, scopes: [...scopes], github,
      grant: { id: 'pull-grant', ownerId: '123', clientId: 'fixture-client', clientName: 'Fixture', instanceId: config.instanceId,
        resource: config.resource, scopes: [...scopes], repositories: grantedRepositories, createdAt: NOW, expiresAt: NOW + 60_000, revoked: false, membershipSource: 'local' } } as unknown as McpPrincipal;

    const tool = (name: string): McpTool => {
      const found = catalog.find(candidate => candidate.name === name);
      assert.ok(found, `${name} is missing from the catalog`);
      return found;
    };
    let sequence = 0;
    const call = async (name: string, args: Args, actor: McpPrincipal = principal) =>
      (await executeTool(tool(name), args, actor, deps)).data as Args;
    const mutate = async (name: string, args: Args, actor: McpPrincipal = principal) =>
      call(name, { ...args, idempotencyKey: `pulls-${name}-${sequence++}` }, actor);

    await t.test('cross-repository listing stays inside the grant and skips forbidden repositories', async () => {
      const listed = await call('list_pull_requests', {});
      assert.deepEqual(listed.repositories, ['acme/repo', 'acme/other', 'acme/bulk']);
      assert.equal(listed.repositoriesTruncated, false);
      assert.equal(listed.order, 'created');
      assert.ok(!graphqlCalls.some(args => `${args.owner}/${args.repo}` === 'acme/forbidden'));
      assert.ok(!graphqlCalls.some(args => `${args.owner}/${args.repo}` === 'acme/ungranted'));
      assert.ok(!graphqlCalls.some(args => `${args.owner}/${args.repo}` === 'acme/disabled'));
      assert.deepEqual(listed.pullRequests.map((pull: Args) => `${pull.repository}#${pull.number}`).slice(0, 3),
        ['acme/repo#42', 'acme/other#7', 'acme/bulk#100']);
      assert.equal(listed.pullRequests.length, 15);
      assert.equal(listed.nextOffset, null);
      const head = listed.pullRequests[0];
      assert.equal(head.title, 'Improve reliability');
      assert.equal(head.state, 'open');
      assert.equal(head.draft, false);
      assert.equal(head.head, 'a'.repeat(40));
      assert.equal(head.base, 'main');
      assert.equal(head.reviewDecision, 'APPROVED');
      assert.deepEqual(head.checksSummary, { state: 'SUCCESS' });
      assert.equal(head.url, 'https://github.com/acme/repo/pull/42');
      assert.ok(head.labels.includes('ultrafix'));
    });

    await t.test('an explicit repository is authorized through the shared policy path', async () => {
      await assert.rejects(call('list_pull_requests', { repository: 'acme/forbidden' }),
        (error: unknown) => error instanceof McpError && error.status === 403);
      await assert.rejects(call('list_pull_requests', { repository: 'acme/ungranted' }),
        (error: unknown) => error instanceof McpError && error.status === 403);
      const scoped = await call('list_pull_requests', { repository: 'acme/repo' });
      assert.deepEqual(scoped.repositories, ['acme/repo']);
      assert.deepEqual(scoped.pullRequests.map((pull: Args) => pull.number), [42]);
    });

    await t.test('recency filters bound the window and choose the ordering field', async () => {
      const opened = await call('list_pull_requests', { openedWithinMinutes: 60 });
      assert.deepEqual(opened.pullRequests.map((pull: Args) => pull.number), [42, 7]);
      assert.equal(opened.order, 'created');
      const updated = await call('list_pull_requests', { updatedWithinMinutes: 3 });
      assert.equal(updated.order, 'updated');
      assert.deepEqual(updated.pullRequests.map((pull: Args) => pull.number), [7]);
      const both = await call('list_pull_requests', { openedWithinMinutes: 60, updatedWithinMinutes: 3 });
      assert.deepEqual(both.pullRequests.map((pull: Args) => pull.number), [7]);
    });

    await t.test('merged state is authoritative and the state filter honours it', async () => {
      const all = await call('list_pull_requests', { repository: 'acme/repo', state: 'all' });
      const states = Object.fromEntries(all.pullRequests.map((pull: Args) => [pull.number, pull.state]));
      assert.deepEqual(states, { 42: 'open', 41: 'merged', 40: 'merged' });
      const closed = await call('list_pull_requests', { repository: 'acme/repo', state: 'closed' });
      assert.deepEqual(closed.pullRequests, []);
      const merged = await call('list_pull_requests', { repository: 'acme/repo', state: 'merged' });
      assert.deepEqual(merged.pullRequests.map((pull: Args) => pull.number), [41]);
    });

    await t.test('the ProPR correlation block ties pull requests to tasks, plans and goals', async () => {
      const listed = await call('list_pull_requests', {});
      const byNumber = Object.fromEntries(listed.pullRequests.map((pull: Args) => [pull.number, pull]));
      const planIssue = await db('plan_issues').where({ draft_id: 'plan-1' }).first('id');
      assert.deepEqual(byNumber[42].propr, { taskId: 'task-42', goalId: null, planIssueId: planIssue.id,
        issueNumber: 88, agentAlias: 'claude', modelName: 'claude-opus-5', ultrafixActive: true });
      assert.deepEqual(byNumber[7].propr, { taskId: null, goalId: 'goal-1', planIssueId: null,
        issueNumber: null, agentAlias: 'codex', modelName: 'gpt-5.6', ultrafixActive: false });
      assert.equal(byNumber[100].propr.taskId, null);
      assert.equal(byNumber[100].propr.ultrafixActive, false);
      // Another user's goal must not leak into the correlation.
      const other = { ...principal, user: { ...principal.user, id: '999' } } as McpPrincipal;
      const foreign = await call('list_pull_requests', { repository: 'acme/other' }, other);
      assert.equal(foreign.pullRequests.find((pull: Args) => pull.number === 7).propr.goalId, null);
    });

    await t.test('includeLatestComment stays bounded and reports truncation', async () => {
      const before = restCalls.filter(item => item.route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments').length;
      const bulk = await call('list_pull_requests', { repository: 'acme/bulk', includeLatestComment: true, limit: 12 });
      assert.equal(bulk.pullRequests.length, 12);
      assert.equal(bulk.latestCommentTruncated, true);
      assert.equal(bulk.pullRequests.filter((pull: Args) => pull.latestComment !== undefined).length, 10);
      const reads = restCalls.filter(item => item.route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments').length - before;
      assert.equal(reads, 10);
      const scoped = await call('list_pull_requests', { repository: 'acme/repo', includeLatestComment: true });
      assert.equal(scoped.latestCommentTruncated, false);
      const latest = scoped.pullRequests[0].latestComment;
      assert.equal(latest.id, 103);
      assert.equal(latest.author, 'fixture-user');
      assert.equal(latest.isProprReview, false);
      assert.equal(latest.excerpt.length, 601);
      assert.ok(latest.excerpt.endsWith('…'));
      const review = (await call('list_pull_requests', { repository: 'acme/other', includeLatestComment: true }))
        .pullRequests.find((pull: Args) => pull.number === 7).latestComment;
      assert.equal(review.isProprReview, true);
      assert.equal(review.author, 'propr-dev[bot]');
      assert.equal((await call('list_pull_requests', { repository: 'acme/repo' })).pullRequests[0].latestComment, undefined);
    });

    await t.test('the discussion can be paged newest-first without reversing a single page', async () => {
      const oldest = await call('get_pull_request_discussion', { repository: 'acme/repo', pullRequest: 42, limit: 2 });
      assert.equal(oldest.order, 'oldest');
      assert.deepEqual(oldest.comments.map((comment: Args) => comment.id), [101, 102]);
      assert.equal(oldest.nextPage, 2);
      const newest = await call('get_pull_request_discussion', { repository: 'acme/repo', pullRequest: 42, limit: 2, order: 'newest' });
      assert.equal(newest.order, 'newest');
      assert.deepEqual(newest.comments.map((comment: Args) => comment.id), [103, 102]);
      assert.equal(newest.nextPage, 2);
      const secondPage = await call('get_pull_request_discussion', { repository: 'acme/repo', pullRequest: 42, limit: 2, order: 'newest', page: 2 });
      assert.deepEqual(secondPage.comments.map((comment: Args) => comment.id), [101]);
      assert.equal(secondPage.nextPage, null);
      const directions = restCalls.filter(item => item.route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments' && item.args.per_page === 2)
        .map(item => item.args.direction);
      assert.deepEqual(directions, ['asc', 'desc', 'desc']);
    });

    await t.test('comment_on_pull_request rejects slash commands and enforces the expected head', async () => {
      const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
      const command = await mutate('comment_on_pull_request', { ...pull, message: '/ultrafix goal=9' });
      assert.equal(command.state, 'failed');
      assert.equal(command.result.error.code, 'USE_EXPLICIT_TOOL');
      const embedded = await mutate('comment_on_pull_request', { ...pull, message: 'Please take another look.\n/merge now' });
      assert.equal(embedded.result.error.code, 'USE_EXPLICIT_TOOL');
      const stale = await mutate('comment_on_pull_request', { ...pull, expectedHead: 'f'.repeat(40), message: 'Cover transient errors too.' });
      assert.equal(stale.result.error.code, 'STALE_HEAD');
      const posted = await mutate('comment_on_pull_request', { ...pull, message: 'Cover transient errors too.' });
      assert.equal(posted.state, 'posted');
      assert.equal(posted.result.expectedHead, 'a'.repeat(40));
      assert.equal(posted.result.pullRequest, 42);
      assert.ok(posted.result.url.includes('#issuecomment-'));
      const stored = comments.find(comment => comment.id === posted.result.commentId)!;
      assert.ok(stored.body.startsWith('Cover transient errors too.'));
      assert.ok(!/^\s*\//m.test(stored.body.split('<!--')[0]));
      // The slash-command attempts must not have reached GitHub.
      assert.ok(!comments.some(comment => comment.body.startsWith('/')));
    });

    await t.test('set_pull_request_model converges on exactly one managed model label', async () => {
      const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
      const routed = await mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' });
      assert.equal(routed.state, 'completed');
      assert.equal(routed.result.label, 'llm-claude-opus-5');
      assert.equal(routed.result.agentAlias, 'claude');
      assert.equal(routed.result.model, 'claude-opus-5');
      assert.deepEqual(routed.result.previousLabels, ['llm-claude-sonnet-5', 'ultrafix', 'auto-merge']);
      assert.deepEqual(routed.result.removedLabels, ['llm-claude-sonnet-5']);
      assert.deepEqual(routed.result.labels, ['ultrafix', 'auto-merge', 'llm-claude-opus-5']);
      const live = findPullRequest('acme/repo', 42).labels;
      assert.deepEqual(live.filter(name => name.startsWith('llm-')), ['llm-claude-opus-5']);
      assert.ok(live.includes('ultrafix') && live.includes('auto-merge'));
      // Re-applying the same model must not add the label twice.
      const adds = restCalls.filter(item => item.route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels').length;
      const again = await mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' });
      assert.deepEqual(again.result.removedLabels, []);
      assert.deepEqual(again.result.labels, ['ultrafix', 'auto-merge', 'llm-claude-opus-5']);
      assert.equal(restCalls.filter(item => item.route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels').length, adds);
    });

    await t.test('set_pull_request_model refuses unknown, disabled and undefined labels', async () => {
      const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
      const unknown = await mutate('set_pull_request_model', { ...pull, model: 'not-a-real-model' });
      assert.equal(unknown.state, 'failed');
      assert.equal(unknown.result.error.code, 'UNKNOWN_MODEL');
      assert.ok(unknown.result.error.message.includes('claude:claude-opus-5'));
      const disabled = await mutate('set_pull_request_model', { ...pull, model: 'claude-haiku-4-5' });
      assert.equal(disabled.result.error.code, 'UNKNOWN_MODEL');
      const missing = await mutate('set_pull_request_model', { ...pull, model: 'gpt-5.6' });
      assert.equal(missing.result.error.code, 'MODEL_LABEL_MISSING');
      assert.ok(missing.result.error.message.includes('codex:gpt-5.6'));
      assert.deepEqual(findPullRequest('acme/repo', 42).labels.filter(name => name.startsWith('llm-')), ['llm-claude-opus-5']);
    });

    await t.test('get_pull_request reports the ultrafix circuit breaker', async () => {
      const read = await call('get_pull_request', { repository: 'acme/repo', pullRequest: 42 });
      assert.deepEqual(read.ultrafix, { active: true });
      assert.equal((await call('get_pull_request', { repository: 'acme/other', pullRequest: 7 })).ultrafix.active, false);
    });

    await t.test('stop_ultrafix clears the breaker honestly and requires review scope', async () => {
      const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
      const withoutReview = { ...principal, scopes: principal.scopes.filter(scope => scope !== 'review') } as McpPrincipal;
      const refused = await mutate('stop_ultrafix', pull, withoutReview);
      assert.equal(refused.state, 'failed');
      assert.equal(refused.result.error.code, 'INSUFFICIENT_SCOPE');
      assert.ok(findPullRequest('acme/repo', 42).labels.includes('ultrafix'));

      const stopped = await mutate('stop_ultrafix', pull);
      assert.equal(stopped.state, 'completed');
      assert.equal(stopped.result.wasActive, true);
      assert.equal(stopped.result.circuitBreaker, 'cleared');
      assert.ok(stopped.result.message.includes('may still finish'));
      assert.doesNotMatch(stopped.result.message, /loop (?:has )?stopped/i);
      assert.ok(!findPullRequest('acme/repo', 42).labels.includes('ultrafix'));
      assert.equal((await call('get_pull_request', { repository: 'acme/repo', pullRequest: 42 })).ultrafix.active, false);
      assert.equal((await call('list_pull_requests', { repository: 'acme/repo' })).pullRequests[0].propr.ultrafixActive, false);

      const deletions = restCalls.filter(item => item.route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}' && item.args.name === 'ultrafix').length;
      const already = await mutate('stop_ultrafix', pull);
      assert.equal(already.result.wasActive, false);
      assert.ok(already.result.message.includes('No ultrafix label was present'));
      assert.equal(restCalls.filter(item => item.route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}' && item.args.name === 'ultrafix').length, deletions);
      const stale = await mutate('stop_ultrafix', { ...pull, expectedHead: 'f'.repeat(40) });
      assert.equal(stale.result.error.code, 'STALE_HEAD');
    });

    await t.test('every new tool declares its scope, strict schema and write posture', async () => {
      assert.equal(tool('list_pull_requests').readOnly, true);
      assert.equal(tool('list_pull_requests').scope, 'read');
      for (const name of ['comment_on_pull_request', 'set_pull_request_model', 'stop_ultrafix']) {
        assert.equal(tool(name).scope, 'execute');
        assert.notEqual(tool(name).readOnly, true);
        assert.ok(tool(name).schema.shape.idempotencyKey, `${name} must carry a mutation receipt key`);
        assert.ok(tool(name).schema.shape.expectedHead, `${name} must enforce a head precondition`);
        await assert.rejects(call(name, { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40), idempotencyKey: 'strict-extra-key', unexpected: true }));
      }
    });
  } finally {
    stubs.forEach(stub => stub.mock.restore());
    await core.closeConnection();
    await rm(root, { recursive: true, force: true });
  }
});
