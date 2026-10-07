import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-observable-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
process.env.NODE_ENV = 'test';

const core = await import('@propr/core');
const { INSTANCE_PERMISSIONS } = await import('@propr/shared');
const { MCP_SCOPES } = await import('../mcp/config.js');
const { McpOAuthProvider } = await import('../mcp/oauth.js');
const { McpPolicy } = await import('../mcp/policy.js');
const { McpStore } = await import('../mcp/store.js');
const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
const sharp = (await import('sharp')).default;

await core.runMigrations();
await core.saveMonitoredRepos([{
  id: 'observable-repository', name: 'acme/repo', enabled: true, baseBranch: 'main',
  visualPreview: { enabled: true, types: ['image'] },
}], core.db);

after(async () => {
  await core.closeConnection();
  await rm(root, { recursive: true, force: true });
});

const repository = 'acme/repo';
const head = 'a'.repeat(40);
const mergedHead = 'b'.repeat(40);
const mergedAt = '2026-09-29T12:00:00.000Z';
const previewAsset = 'observable-surface-image';
const previewBody = `<!-- propr-visual-preview -->
### Observable result

![Observable result](https://github.com/user-attachments/assets/${previewAsset})`;

function restPull(number: number): Json {
  if (number === 43) return {
    number, title: 'Already merged', body: '', body_html: '', state: 'closed', draft: false, merged: true,
    merged_at: mergedAt, merge_commit_sha: mergedHead, closed_at: mergedAt,
    head: { sha: mergedHead }, base: { ref: 'main' }, html_url: `https://github.com/${repository}/pull/${number}`,
    labels: [],
  };
  return {
    number, title: 'Observable result', body: previewBody, body_html: '', state: 'open', draft: false, merged: false,
    merged_at: null, merge_commit_sha: null, closed_at: null,
    head: { sha: head }, base: { ref: 'main' }, html_url: `https://github.com/${repository}/pull/${number}`,
    labels: [],
  };
}

function graphPull(number: number): Json {
  if (number === 43) return {
    state: 'MERGED', isDraft: false, merged: true, mergedAt, closedAt: mergedAt,
    mergeCommit: { oid: mergedHead }, headRefOid: mergedHead, baseRefName: 'main', mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED', url: `https://github.com/${repository}/pull/${number}`,
    commits: { nodes: [{ commit: { id: 'merged-commit', statusCheckRollup: {
      state: 'SUCCESS', contexts: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } }] },
  };
  return {
    number, url: `https://github.com/${repository}/pull/${number}`, state: 'OPEN', isDraft: false, merged: false,
    headRefOid: head, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
  };
}

function ultrafixJob(commentId: number, mode: 'review' | 'fix'): string {
  return JSON.stringify({
    commandCommentId: commentId, commandCommentType: 'issue', commandMode: mode,
    ultrafixMeta: { mode: 'ultrafix', workEpoch: 7, goal: 9, maxCycles: 2 },
  });
}

test('observable MCP surface keeps receipts, errors, overview, docs and previews coherent end to end', async () => {
  const db = core.db;
  const config = {
    origin: 'https://instance.example', resource: 'https://instance.example/api/mcp',
    instanceId: 'observable-instance', encryptionKey: randomBytes(32),
  };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  let graphCalls = 0;
  let issueCreated = false;
  let rejectPublication = false;
  let commentId = 700;

  const github = {
    request: async (route: string, args: Json) => {
      if (route === 'GET /repos/{owner}/{repo}') return { data: { permissions: { push: true, admin: false } } };
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: restPull(Number(args.pull_number)) };
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        return { data: { id: commentId++, html_url: `https://github.com/${repository}/pull/${args.issue_number}#issuecomment-${commentId - 1}` } };
      }
      if (route === 'POST /repos/{owner}/{repo}/issues') {
        if (rejectPublication) throw Object.assign(new Error('Validation Failed'), {
          name: 'HttpError', status: 422,
          response: { status: 422, headers: {}, data: {
            message: 'Validation Failed for github_pat_observableSurfaceSecret1234567890',
            errors: [{ message: 'Bad label' }],
          } },
        });
        assert.equal(issueCreated, false, 'create_task creates exactly one issue');
        issueCreated = true;
        return { data: { number: 11, html_url: `https://github.com/${repository}/issues/11`, title: args.title } };
      }
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') return { data: [] };
      if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [] };
      if (route.endsWith('/timeline')) return { data: [] };
      throw new Error(`Unexpected GitHub request: ${route}`);
    },
    graphql: async (_query: string, args: Json) => {
      graphCalls += 1;
      if (Number(args.number) === 43) return { repository: { pullRequest: graphPull(43) } };
      return { repository: { pr_42: graphPull(42) } };
    },
  };

  const principal = {
    user: {
      id: '123', login: 'admin', username: 'admin', displayName: 'Admin', email: null, avatarUrl: null,
      accessToken: 'fixture-access-token',
    },
    authorization: { role: 'admin', source: 'local', permissions: [...INSTANCE_PERMISSIONS] },
    scopes: [...MCP_SCOPES],
    grant: {
      id: 'observable-grant', ownerId: '123', clientId: 'observable-client', clientName: 'Observable regression',
      instanceId: config.instanceId, resource: config.resource, scopes: [...MCP_SCOPES], repositories: [repository],
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local',
    },
    github,
  } as never;
  const sourceImage = await sharp({ create: {
    width: 32, height: 24, channels: 3, background: '#315efb',
  } }).png().toBuffer();
  const deps = {
    db, policy,
    taskQueue: {} as never,
    runtimeBuildQueue: {} as never,
    redisClient: { get: async () => null } as never,
    taskSubmissionServices: {
      authorize: async () => ({ id: 'repo', name: repository, enabled: true, baseBranch: 'main' }),
      routing: async () => ({ agentAlias: 'codex', model: 'gpt-test', routingLabel: 'llm-codex-test' }),
      getOctokit: async () => github,
      processingLabels: async () => ['AI'],
      enqueue: async () => undefined,
    },
    visualPreviews: {
      reader: { enabledRepositories: async () => new Set([repository]) },
      fetch: async () => new Response(sourceImage, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    },
  } as never;
  const catalog = createToolCatalog(deps);
  const named = (name: string) => {
    const found = catalog.find(candidate => candidate.name === name);
    assert.ok(found, `${name} is registered`);
    return found;
  };
  const call = async (name: string, args: Json = {}) => (await executeTool(named(name), args, principal, deps)).data as Json;

  const created = await call('create_task', {
    repository, instruction: 'Document the observable surface.', idempotencyKey: 'observable-create-task',
  });
  assert.equal(created.result.progress.stage, 'queued');
  const submissionId = created.result.submissionId as string;
  const submission = await call('get_task_submission', { repository, submissionId });
  assert.equal(submission.progress.stage, 'queued');

  await db('tasks').insert({ task_id: 'observable-task', repository, task_type: 'issue', pr_number: null });
  await db('task_submissions').where({ id: submissionId }).update({ task_id: 'observable-task', latest_task_id: 'observable-task' });
  await db('task_history').insert({ task_id: 'observable-task', state: 'processing', timestamp: new Date().toISOString() });
  const running = await call('get_operation', { operationId: created.operationId });
  assert.equal(running.lifecycle.state, 'running');
  assert.ok(running.lifecycle.startedAt);

  await db('tasks').where({ task_id: 'observable-task' }).update({ pr_number: 42 });
  await db('task_history').insert({ task_id: 'observable-task', state: 'completed', timestamp: new Date().toISOString() });
  const completed = await call('get_operation', { operationId: created.operationId });
  assert.equal(completed.lifecycle.state, 'completed');
  assert.equal(completed.lifecycle.artifacts.pullRequest.number, 42);
  assert.ok(completed.lifecycle.finishedAt);

  const callsBeforeOverview = graphCalls;
  const overview = await call('get_work_overview', { repository, state: 'all', limit: 20 });
  assert.equal(graphCalls - callsBeforeOverview, 1);
  const overviewItem = overview.items.find((item: Json) => item.task.task_id === 'observable-task');
  assert.equal(overviewItem.pullRequest.number, 42);
  assert.equal(overviewItem.pullRequest.head, head);

  const ultrafix = await call('run_ultrafix', {
    repository, pullRequest: 42, goal: 9, maxCycles: 2, idempotencyKey: 'observable-ultrafix',
  });
  assert.equal(ultrafix.result.resolvedHead, head);
  assert.equal(ultrafix.result.headSource, 'server');
  const ultrafixCommentId = ultrafix.result.commentId as number;
  const taskTime = new Date(Date.now() + 10).toISOString();
  await db('tasks').insert([
    { task_id: 'ultrafix-review-1', repository, issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      initial_job_data: ultrafixJob(ultrafixCommentId, 'review'), created_at: taskTime },
    { task_id: 'ultrafix-fix-1', repository, issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      initial_job_data: ultrafixJob(0, 'fix'), created_at: taskTime },
    { task_id: 'ultrafix-review-2', repository, issue_number: 42, pr_number: 42, task_type: 'pr-comment',
      initial_job_data: ultrafixJob(0, 'review'), created_at: taskTime },
  ]);
  await db('task_history').insert([
    { task_id: 'ultrafix-review-1', state: 'completed', timestamp: taskTime,
      metadata: JSON.stringify({ ultrafixCycle: 1, ultrafixScore: 6 }) },
    { task_id: 'ultrafix-fix-1', state: 'completed', timestamp: taskTime,
      metadata: JSON.stringify({ ultrafixCycle: 1 }) },
    { task_id: 'ultrafix-review-2', state: 'processing', timestamp: taskTime,
      metadata: JSON.stringify({ ultrafixCycle: 2, ultrafixScore: 7 }) },
  ]);
  const cycling = await call('get_operation', { operationId: ultrafix.operationId });
  assert.equal(cycling.lifecycle.state, 'running');
  assert.equal(cycling.lifecycle.progress.cycle, 2);

  await db('task_history').insert({
    task_id: 'ultrafix-review-2', state: 'completed', timestamp: new Date(Date.now() + 20).toISOString(),
    metadata: JSON.stringify({
      ultrafixCycle: 2, ultrafixScore: 7, ultrafixGoal: 9, ultrafixMaxCycles: 2,
      ultrafixOutcome: 'cycles_exhausted',
    }),
  });
  const exhausted = await call('get_operation', { operationId: ultrafix.operationId });
  assert.equal(exhausted.lifecycle.state, 'completed');
  assert.equal(exhausted.lifecycle.progress.outcome, 'cycles_exhausted');
  assert.match(exhausted.lifecycle.summary, /did not reach goal 9/);
  const recentUltrafix = await call('list_operations', { tool: 'run_ultrafix', sinceMinutes: 60 });
  assert.ok(recentUltrafix.operations.some((operation: Json) => operation.operationId === ultrafix.operationId
    && operation.lifecycle.state === 'completed'));

  const merge = await call('merge_pull_request', {
    repository, pullRequest: 43, expectedHead: mergedHead, method: 'squash', idempotencyKey: 'observable-merged-pr',
  });
  assert.equal(merge.lifecycle.state, 'failed');
  assert.equal(merge.result.error.code, 'PULL_REQUEST_ALREADY_MERGED');
  assert.equal(merge.result.error.details.currentState.mergedAt, mergedAt);

  const planId = '26090000-0000-4000-8000-000000000001';
  await db('task_drafts').insert({
    draft_id: planId, user_id: '123', repository, status: 'review',
    plan_json: JSON.stringify([{ title: 'Publish me', body: 'Body', implementation: 'Implementation' }]),
  });
  const plan = await db('task_drafts').where({ draft_id: planId }).first();
  rejectPublication = true;
  const publication = await call('publish_plan', {
    repository, planId, expectedRevision: plan.mcp_revision, idempotencyKey: 'observable-publish-failure',
  });
  assert.equal(publication.lifecycle.state, 'failed');
  assert.equal(publication.result.error.code, 'PUBLISH_FAILED');
  assert.equal(publication.result.error.details.cause.code, 'GITHUB_REJECTED');
  assert.equal((await db('task_drafts').where({ draft_id: planId }).first()).status, 'review');

  for (const failure of [merge.result.error, publication.result.error]) {
    const serialized = JSON.stringify(failure);
    assert.doesNotMatch(serialized, /(?:github_pat_|gh[pousr]_|Bearer\s+|(?:pia|propr)_mcp_)[A-Za-z0-9._~-]+/i);
  }
  assert.doesNotMatch(JSON.stringify(publication), /observableSurfaceSecret/);

  const listedDocs = await call('list_docs', { section: 'mcp', limit: 20 });
  assert.ok(listedDocs.pages.some((page: Json) => page.path === 'mcp/guide'));
  const docs = await call('search_docs', { query: 'ultrafix', limit: 5 });
  assert.ok(docs.results.length > 0);
  assert.ok(docs.results.some((result: Json) => typeof result.path === 'string'));
  const setting = await call('find_setting', { query: 'bot whitelist' });
  assert.equal(setting.matches[0].id, 'trigger.bot_allowlist');

  const previews = await call('list_visual_previews', { repository, pullRequest: 42 });
  assert.equal(previews.previews[0].previewId, `pull:42:${previewAsset}`);
  const previewTool = named('get_visual_preview');
  const preview = await executeTool(previewTool, {
    repository, previewId: `pull:42:${previewAsset}`, maxDimension: 256,
  }, principal, deps);
  assert.equal(preview.content?.[0]?.type, 'image');
  assert.equal((preview.data as Json).mimeType, 'image/webp');

  const guide = await readFile(new URL('../../../docs/mcp.md', import.meta.url), 'utf8');
  const documentedTokens = new Set([...guide.matchAll(/`([a-z_]+)`/g)].map(match => match[1]));
  const nonToolTokens = new Set([
    'accepted', 'active', 'activity', 'all', 'approved', 'artifacts', 'auth', 'authorization', 'blockers',
    'cancelled', 'cause', 'cf_tunnel_id', 'client', 'code', 'completed', 'connection', 'count', 'creation', 'cursor',
    'cycle', 'cycles_exhausted', 'database', 'denied', 'deploy', 'details', 'direct', 'draft', 'error', 'execute',
    'executed', 'executing', 'failed', 'false', 'format', 'generating', 'github', 'goal_reached', 'head', 'instruction',
    'instructions', 'internal', 'iss', 'issue_created', 'issues', 'items', 'kind', 'labels', 'limit', 'manage',
    'mcp_access_log', 'mcp_operations', 'mcp_records', 'merge', 'merged', 'message', 'model', 'models',
    'name', 'node', 'none', 'notifications', 'null', 'number', 'offset', 'orchestrate', 'outcome', 'page', 'path', 'plan', 'plan_issues',
    'posted', 'pr_created', 'precondition', 'private_key_jwt', 'progress', 'prompt', 'propr', 'publish',
    'queue', 'queued', 'read', 'refining', 'repositories', 'repository', 'resource', 'retryable', 'review',
    'role', 'running', 'section', 'since', 'stage', 'started', 'state', 'status', 'stopped', 'submitted', 'success', 'true',
    'timing', 'token_endpoint_auth_methods_supported', 'tool', 'transport', 'truncated', 'tunnel_id',
    'ultrafix', 'unknown', 'until', 'validation', 'workflow',
    // Comment attachment fields and selectors returned by get_pull_request_discussion.
    'alt', 'attachments', 'fetchable', 'image', 'index', 'issue', 'type', 'video',
    // Per-model review receipt fields returned by review_pull_request with model.
    'reviews', 'not_posted', 'rejected', 'url',
    // Goal blocker fields and categories returned by get_goal and list_goal_attention.
    'approval', 'attempt', 'category', 'detection', 'id', 'paused', 'paused_awaiting_resume_or_input',
    'provider_approval', 'provider_question', 'question', 'questions', 'reason', 'summary',
    // Conditions, outcomes and event fields returned by wait_goal.
    'checkpoint', 'condition', 'event', 'lifecycle', 'matched', 'terminal', 'timed_out', 'unreachable',
    // Re-anchoring report fields returned by fix_review_findings.
    'applied', 'skipped', 'comparison', 'same_head', 'compared', 'unavailable', 'code_removed',
    // Instance settings the omitted ultrafix bounds resolve from.
    'ultrafix_rating_goal', 'ultrafix_max_cycles', 'goal', 'maxCycles',
    // Input fields and categories accepted by generate_repository_improvements.
    'branch', 'categories', 'architecture', 'documentation', 'performance', 'scalability', 'security', 'testing',
    // Agent run receipt fields, run states and autonomy modes returned by the agent run tools.
    'created', 'deferred', 'awaiting_approval', 'dry_run', 'preview', 'auto', 'note',
    // Prompt names share tool-like spelling but are discovered under prompts/list.
    'check_progress', 'diagnose_failure', 'operator_briefing', 'plan_change', 'prepare_handoff',
    'review_and_improve_pr', 'start_goal',
  ]);
  const adminToolNames = new Set(catalog
    .filter(tool => principal.scopes.includes(tool.scope)
      && (!tool.permission || principal.authorization.permissions.includes(tool.permission)))
    .map(tool => tool.name));
  for (const token of documentedTokens) {
    assert.ok(adminToolNames.has(token) || nonToolTokens.has(token),
      `docs/mcp.md names ${token}, but it is neither an admin-visible tool nor an explicit non-tool token`);
  }
});
