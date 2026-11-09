import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ToolDeps } from '../mcp/tools.js';
import type { FollowupHandoffKey, FollowupHandoffRouteDeps, FollowupHandoffStatus } from '../routes/followupHandoffRoutes.js';

const repository = 'integry/propr';
const outsideGrant = 'other-org/secret';
const revokedOnGitHub = 'integry/revoked';
const unconfigured = 'integry/unconfigured';
const root = await mkdtemp(path.join(tmpdir(), 'mcp-maintenance-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

const core = await import('@propr/core');
const coreMock = await mock.module('@propr/core', {
  namedExports: { ...core, loadMonitoredReposRaw: async () => [repository, outsideGrant, revokedOnGitHub].map(name => ({ name, enabled: true, baseBranch: 'main' })) },
});
after(async () => { coreMock.restore(); await core.closeConnection(); await rm(root, { recursive: true, force: true }); });

function status(overrides: Partial<FollowupHandoffStatus['record']> = {}): FollowupHandoffStatus {
  return {
    record: {
      repository, pull_request: 3423, task_id: 'pr-comments-batch-integry-propr-3423', phase: 'agent_running',
      status: 'awaiting_operator', status_reason: 'fork_publication_unsupported', operator_authorized: 0,
      branch_name: 'labels-fix', worktree_path: '/tmp/git-processor/worktrees/bharveyos/propr/pr-3423-followup',
      commit_hash: null, completion_comment_url: null, updated_at: 1794092314931, ...overrides,
    },
    liveness: 'not_checked', nextAction: 'repair the reported condition, then resume to re-arm recovery, or release to stop tracking it',
    predecessorTaskIds: [], successorTaskId: null,
  };
}

test('maintenance tools list, inspect, release and resume follow-up handoffs under the runtime permission', async () => {
  await core.runMigrations();
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { McpError } = await import('../mcp/config.js');
  const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
  const mcpConfig = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(core.db, mcpConfig.encryptionKey), mcpConfig), mcpConfig);
  const principal = {
    user: { id: '829273', username: 'integry' },
    authorization: { permissions: ['instance.manage_runtime'], role: 'admin', source: 'local' },
    scopes: ['read', 'manage'],
    grant: { id: 'maintenance-grant', repositories: [repository], membershipSource: 'local' },
    github: { request: async () => ({ data: { permissions: { push: true, admin: true } } }) },
  } as unknown as McpPrincipal;

  const calls: Array<{ name: string; key?: FollowupHandoffKey; options?: unknown }> = [];
  let released = false;
  const handoffs: FollowupHandoffRouteDeps = {
    inspectFollowupHandoffs: async (_deps, key) => {
      calls.push({ name: 'inspect', key });
      if (released) return [];
      return key && key.pull_request !== 3423 ? [] : [status()];
    },
    releaseFollowupHandoffRecord: async (key, options) => {
      calls.push({ name: 'release', key, options });
      if (key.pull_request !== 3423) return { released: false, reason: 'not_found' };
      if (!options.force) return { released: false, reason: 'worktree_holds_unpublished_work' };
      released = true;
      return { released: true };
    },
    resumeOperatorHeldFollowupHandoff: async key => {
      calls.push({ name: 'resume', key });
      return key.pull_request === 3423 ? { resumed: true } : { resumed: false, reason: 'not_found' };
    },
    authorizeCancelledFollowupHandoff: async key => { calls.push({ name: 'authorize', key }); return null; },
    recoverInterruptedFollowupHandoffs: async (_deps, key) => {
      calls.push({ name: 'recover', key });
      return { inspected: 1, published: 0, noChanges: 0, settled: 0, cleanupPending: 0, skippedLiveAgent: 0, failedClosed: 0, awaitingOperator: 1, lockedByOtherWriter: 0, errors: 0 };
    },
  };
  const deps = {
    db: core.db, policy, followupHandoffs: handoffs,
    redisClient: { set: async () => 'OK', get: async () => null, eval: async () => 1, publish: async () => 1, lPush: async () => 1, lTrim: async () => 'OK' },
    taskQueue: {}, runtimeBuildQueue: {},
  } as unknown as ToolDeps;
  const catalog = createToolCatalog(deps);
  const tool = (name: string) => catalog.find(entry => entry.name === name)!;
  for (const name of ['list_followup_handoffs', 'get_followup_handoff', 'release_followup_handoff', 'resume_followup_handoff']) {
    assert.equal(tool(name).scope, 'manage', `${name} is a manage tool`);
    assert.equal(tool(name).permission, 'instance.manage_runtime', `${name} requires the runtime permission, like the admin routes`);
  }
  assert.equal(tool('list_followup_handoffs').readOnly, true);
  assert.equal(tool('get_followup_handoff').readOnly, true);
  assert.notEqual(tool('release_followup_handoff').readOnly, true);

  const withoutPermission = { ...principal, authorization: { ...principal.authorization, permissions: ['instance.manage_settings'] } };
  await assert.rejects(executeTool(tool('list_followup_handoffs'), {}, withoutPermission, deps), /instance.manage_runtime/);
  await assert.rejects(executeTool(tool('release_followup_handoff'), { repository, pullRequest: 3423, idempotencyKey: 'denied-release' }, withoutPermission, deps), /instance.manage_runtime/);
  assert.deepEqual(calls, [], 'a denied call never reaches the recovery module');

  const listed = (await executeTool(tool('list_followup_handoffs'), {}, principal, deps)).data as { handoffs: Array<Record<string, unknown>> };
  assert.equal(listed.handoffs.length, 1);
  assert.equal(listed.handoffs[0].repository, repository);
  assert.equal(listed.handoffs[0].pullRequest, 3423);
  assert.equal(listed.handoffs[0].status, 'awaiting_operator');
  assert.equal(listed.handoffs[0].statusReason, 'fork_publication_unsupported');
  assert.equal(listed.handoffs[0].retainedWorktree, true);
  assert.ok(!JSON.stringify(listed).includes('/tmp/git-processor'), 'the worker host path stays on the REST route and CLI, not in chat results');

  const one = (await executeTool(tool('get_followup_handoff'), { repository, pullRequest: 3423 }, principal, deps)).data as { status: Record<string, unknown> };
  assert.equal(one.status.taskId, 'pr-comments-batch-integry-propr-3423');
  assert.deepEqual(calls.at(-1), { name: 'inspect', key: { repository, pull_request: 3423 } });
  await assert.rejects(executeTool(tool('get_followup_handoff'), { repository, pullRequest: 99 }, principal, deps), (error: unknown) => error instanceof McpError && error.code === 'NOT_FOUND' && error.status === 404);

  // Mutating tools answer with a durable operation receipt; a refusal is a failed receipt
  // that names the recovery module's reason instead of a generic rejection.
  type Receipt = { state: string; result: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mutate = async (name: string, args: Record<string, unknown>) => (await executeTool(tool(name), args, principal, deps)).data as Receipt;
  const plain = await mutate('release_followup_handoff', { repository, pullRequest: 3423, idempotencyKey: 'release-plain-0001' });
  assert.equal(plain.state, 'failed');
  assert.equal(plain.result.error.code, 'HANDOFF_NOT_RELEASED');
  assert.match(plain.result.error.message, /worktree_holds_unpublished_work/);
  assert.deepEqual(calls.at(-1), { name: 'release', key: { repository, pull_request: 3423 }, options: { force: false } });

  const forced = await mutate('release_followup_handoff', { repository, pullRequest: 3423, force: true, idempotencyKey: 'release-force-0001' });
  assert.equal(forced.state, 'completed');
  assert.equal(forced.result.released, true);
  assert.equal(forced.result.forced, true);
  assert.deepEqual(calls.at(-1), { name: 'release', key: { repository, pull_request: 3423 }, options: { force: true } });
  assert.deepEqual(((await executeTool(tool('list_followup_handoffs'), {}, principal, deps)).data as { handoffs: unknown[] }).handoffs, [], 'the released hold is gone from the list');
  const missing = await mutate('release_followup_handoff', { repository, pullRequest: 99, idempotencyKey: 'release-missing-001' });
  assert.equal(missing.state, 'failed');
  assert.equal(missing.result.error.code, 'NOT_FOUND');

  released = false;
  const resumed = await mutate('resume_followup_handoff', { repository, pullRequest: 3423, idempotencyKey: 'resume-0000000001' });
  assert.equal(resumed.state, 'completed');
  assert.equal(resumed.result.summary.awaitingOperator, 1);
  assert.equal(resumed.result.status?.pullRequest, 3423);
  assert.deepEqual(calls.slice(-3).map(call => call.name), ['resume', 'recover', 'inspect'], 'resume re-arms, then runs the keyed recovery pass, then reports');
  const authorize = await mutate('resume_followup_handoff', { repository, pullRequest: 3423, authorizeCancelled: true, idempotencyKey: 'resume-authorize-01' });
  assert.equal(authorize.state, 'failed');
  assert.equal(authorize.result.error.code, 'HANDOFF_NOT_RESUMED');
  assert.equal(calls.at(-1)?.name, 'authorize');
});

test('list_followup_handoffs shows only handoffs in repositories the client may currently read', async () => {
  await core.runMigrations();
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
  const mcpConfig = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(core.db, mcpConfig.encryptionKey), mcpConfig), mcpConfig);
  const githubChecks: string[] = [];
  const principal = {
    user: { id: '829273', username: 'integry' },
    authorization: { permissions: ['instance.manage_runtime'], role: 'admin', source: 'local' },
    scopes: ['read', 'manage'],
    // An instance administrator whose client was granted fewer repositories than the instance tracks.
    grant: { id: 'narrow-grant', repositories: [repository, revokedOnGitHub, unconfigured], membershipSource: 'local' },
    github: { request: async (_route: string, params: { owner: string; repo: string }) => {
      githubChecks.push(`${params.owner}/${params.repo}`);
      if (`${params.owner}/${params.repo}` === revokedOnGitHub) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: { permissions: { pull: true } } };
    } },
  } as unknown as McpPrincipal;
  const records = [
    status(),
    status({ pull_request: 3424, task_id: 'pr-comments-batch-integry-propr-3424' }),
    status({ repository: outsideGrant, pull_request: 7, task_id: 'pr-comments-batch-other-org-secret-7', branch_name: 'secret-branch' }),
    status({ repository: revokedOnGitHub, pull_request: 8, task_id: 'pr-comments-batch-integry-revoked-8' }),
    status({ repository: unconfigured, pull_request: 9, task_id: 'pr-comments-batch-integry-unconfigured-9' }),
  ];
  const unused = async () => { throw new Error('the list must not call a mutating recovery entry point'); };
  const deps = {
    db: core.db, policy,
    followupHandoffs: { inspectFollowupHandoffs: async () => records, releaseFollowupHandoffRecord: unused, resumeOperatorHeldFollowupHandoff: unused, authorizeCancelledFollowupHandoff: unused, recoverInterruptedFollowupHandoffs: unused },
    redisClient: { set: async () => 'OK', get: async () => null, eval: async () => 1, publish: async () => 1, lPush: async () => 1, lTrim: async () => 'OK' },
    taskQueue: {}, runtimeBuildQueue: {},
  } as unknown as ToolDeps;
  const list = createToolCatalog(deps).find(entry => entry.name === 'list_followup_handoffs')!;

  const listed = (await executeTool(list, {}, principal, deps)).data as { handoffs: Array<Record<string, unknown>> };
  assert.deepEqual(listed.handoffs.map(handoff => `${handoff.repository}#${handoff.pullRequest}`), [`${repository}#3423`, `${repository}#3424`]);
  const text = JSON.stringify(listed);
  for (const hidden of [outsideGrant, 'secret-branch', revokedOnGitHub, unconfigured]) assert.ok(!text.includes(hidden), `${hidden} is not disclosed`);
  assert.deepEqual(githubChecks.sort(), [repository, revokedOnGitHub], 'current GitHub access is checked once per granted, configured repository');
});
