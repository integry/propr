import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { McpError } from '../mcp/config.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { McpStore } from '../mcp/store.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';
import { IMPROVEMENTS_TIMEOUT_MS } from '../mcp/toolsImprovements.js';
import { ImprovementsOutputError, type RepoImprovementsRequest, type RepoImprovementsResult } from '../services/repoImprovements.js';

after(closeConnection);

const repository = 'acme/repo';
const reference = 'acme/reference';

function actor(repositories = [repository, reference]): McpPrincipal {
  return {
    user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'caller-token' },
    authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant', ownerId: '123', clientId: 'client', clientName: 'Test', instanceId: 'test-instance',
      resource: 'https://instance.example/api/mcp', scopes: ['read', 'plan'], repositories, createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
    scopes: ['read', 'plan'],
    github: {} as McpPrincipal['github'],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const suggestions = [
  { title: 'Add input validation', description: 'Validate request bodies before use.' },
  { title: 'Cache summaries', description: 'Avoid rebuilding summaries per request.' },
];

function result(request: RepoImprovementsRequest): RepoImprovementsResult {
  return {
    success: true, suggestions,
    metadata: { repository: request.repository, branch: request.branch || 'HEAD', categories: request.categories,
      referenceRepoId: request.referenceRepoId || null, suggestionCount: suggestions.length },
    estimatedDurationMs: 12_000, actualDurationMs: 9_500, isHistoricalEstimate: true,
  };
}

async function setup(t: { after: (fn: () => Promise<void>) => void }, generate: NonNullable<ToolDeps['repoImprovements']>['generate']) {
  const db: Knex = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  const authorized: string[] = [];
  policy.repository = async (principal, name) => {
    authorized.push(name);
    if (!principal.grant.repositories?.includes(name)) throw new McpError('REPOSITORY_FORBIDDEN', 'Repository is not in this grant.', 403);
  };
  const jobs: Array<() => Promise<void>> = [];
  const deps: ToolDeps = { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never,
    repoImprovements: { generate, schedule: job => { jobs.push(job); } } };
  const catalog = createToolCatalog(deps);
  const tool = (name: string) => catalog.find(candidate => candidate.name === name)!;
  const getOperation = async (operationId: unknown, principal = actor()) =>
    (await executeTool(tool('get_operation'), { operationId }, principal, deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- receipt projection
  return { db, deps, tool, jobs, authorized, getOperation };
}

test('generate_repository_improvements validates inputs like the HTTP route', async t => {
  const { tool } = await setup(t, async () => { throw new Error('must not run'); });
  const schema = tool('generate_repository_improvements').schema;
  assert.equal(tool('generate_repository_improvements').scope, 'plan');
  assert.match(tool('generate_repository_improvements').description, /get_operation/);
  const base = { idempotencyKey: 'improve-key-1', repository };
  assert.equal(schema.safeParse({ ...base, categories: ['security', 'new-features'] }).success, true);
  assert.equal(schema.safeParse({ ...base, customPrompt: 'What should we build next?' }).success, true);
  assert.equal(schema.safeParse({ ...base, categories: ['security'], branch: 'main', referenceRepository: reference,
    model: 'claude-opus-5-5', contextLevel: 75 }).success, true);
  // At least one category or a non-blank prompt, as POST /api/repos/improvements requires.
  assert.equal(schema.safeParse({ ...base, categories: [] }).success, false);
  assert.equal(schema.safeParse({ ...base, customPrompt: '   ' }).success, false);
  assert.equal(schema.safeParse({ ...base, categories: ['vibes'] }).success, false);
  assert.equal(schema.safeParse({ ...base, categories: ['security'], contextLevel: 101 }).success, false);
  assert.equal(schema.safeParse({ ...base, categories: ['security'], repository: 'not-a-repository' }).success, false);
  assert.equal(schema.safeParse({ ...base, categories: ['security'], referenceRepository: 'nope' }).success, false);
  assert.equal(schema.safeParse({ ...base, categories: ['security'], unexpected: true }).success, false);
  assert.equal(schema.safeParse({ repository, categories: ['security'] }).success, false, 'idempotencyKey is required');
});

test('generation returns an accepted receipt, runs in the background and exposes suggestions on the operation', async t => {
  const started = deferred<void>();
  const finish = deferred<void>();
  const requests: RepoImprovementsRequest[] = [];
  const { tool, jobs, deps, authorized, getOperation } = await setup(t, async (request, target) => {
    requests.push(request);
    assert.deepEqual({ owner: target.owner, repoName: target.repoName }, { owner: 'acme', repoName: 'repo' });
    started.resolve();
    await finish.promise;
    return result(request);
  });
  const args = { idempotencyKey: 'improve-key-2', repository, branch: 'main', categories: ['security'],
    customPrompt: 'Focus on the API.', referenceRepository: reference, model: 'claude-opus-5-5', contextLevel: 25 };
  const accepted = (await executeTool(tool('generate_repository_improvements'), args, actor(), deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- receipt projection
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.lifecycle.state, 'accepted');
  assert.equal(accepted.retryAfterSeconds, 3);
  assert.equal(accepted.result.suggestions, undefined);
  assert.equal(accepted.result.retrieveWith, 'get_operation');
  assert.ok(authorized.includes(reference), 'the reference repository is authorized against the grant');
  assert.equal(jobs.length, 1);
  assert.equal(requests.length, 0, 'generation does not block the call');

  const job = jobs[0]();
  await started.promise;
  const running = await getOperation(accepted.operationId);
  assert.equal(running.lifecycle.state, 'running');
  assert.ok(running.lifecycle.startedAt);
  assert.equal(running.retryAfterSeconds, 3);

  finish.resolve();
  await job;
  assert.deepEqual(requests, [{ repository, branch: 'main', categories: ['security'], customPrompt: 'Focus on the API.',
    referenceRepoId: reference, model: 'claude-opus-5-5', contextLevel: 25 }]);
  const completed = await getOperation(accepted.operationId);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.lifecycle.state, 'completed');
  assert.ok(completed.lifecycle.finishedAt);
  assert.equal(completed.retryAfterSeconds, undefined);
  assert.deepEqual(completed.result.suggestions, suggestions);
  for (const suggestion of completed.result.suggestions) assert.deepEqual(Object.keys(suggestion).sort(), ['description', 'title']);
  assert.equal(completed.result.metadata.suggestionCount, 2);
  assert.equal(completed.result.estimatedDurationMs, 12_000);
  assert.equal(completed.result.actualDurationMs, 9_500);
  assert.equal(completed.result.isHistoricalEstimate, true);

  // Replaying the same key returns the stored receipt without generating again.
  const replay = (await executeTool(tool('generate_repository_improvements'), args, actor(), deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- receipt projection
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.state, 'completed');
  assert.equal(jobs.length, 1);

  const listed = (await executeTool(tool('list_operations'), { tool: 'generate_repository_improvements' }, actor(), deps)).data as { operations: Array<Record<string, unknown>> };
  assert.deepEqual(listed.operations.map(operation => operation.operationId), [accepted.operationId]);
});

test('invalid model output and generation errors fail the operation with a structured error', async t => {
  let failure: Error = new ImprovementsOutputError('Failed to parse improvement suggestions from LLM response');
  const { tool, jobs, deps, getOperation } = await setup(t, async () => { throw failure; });
  const invalid = (await executeTool(tool('generate_repository_improvements'),
    { idempotencyKey: 'improve-key-3', repository, categories: ['testing'] }, actor(), deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- receipt projection
  await jobs[0]();
  const failed = await getOperation(invalid.operationId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.lifecycle.state, 'failed');
  assert.equal(failed.lifecycle.failure.code, 'IMPROVEMENTS_OUTPUT_INVALID');
  assert.equal(failed.result.error.code, 'IMPROVEMENTS_OUTPUT_INVALID');
  assert.equal(failed.result.suggestions, undefined);

  failure = new Error('clone failed with ghp_secretToken123');
  const errored = (await executeTool(tool('generate_repository_improvements'),
    { idempotencyKey: 'improve-key-4', repository, customPrompt: 'Ideas please' }, actor(), deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- receipt projection
  await jobs[1]();
  const erroredReceipt = await getOperation(errored.operationId);
  assert.equal(erroredReceipt.state, 'failed');
  assert.equal(erroredReceipt.lifecycle.state, 'failed');
  assert.doesNotMatch(JSON.stringify(erroredReceipt), /ghp_secretToken123/);
});

test('an unauthorized reference repository is rejected before generation starts', async t => {
  const { tool, jobs, deps } = await setup(t, async () => { throw new Error('must not run'); });
  const receipt = (await executeTool(tool('generate_repository_improvements'),
    { idempotencyKey: 'improve-key-5', repository, categories: ['security'], referenceRepository: 'other/private' }, actor(), deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- receipt projection
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.result.error.code, 'REPOSITORY_FORBIDDEN');
  assert.equal(jobs.length, 0);
});

test('a generation that outlived its bound is reported as interrupted instead of polling forever', async t => {
  const { db, tool, deps, getOperation } = await setup(t, async request => result(request));
  const accepted = (await executeTool(tool('generate_repository_improvements'),
    { idempotencyKey: 'improve-key-6', repository, categories: ['performance'] }, actor(), deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- receipt projection
  // The scheduled job never runs, as after a process restart.
  await db('mcp_operations').where({ id: accepted.operationId }).update({ accepted_at: Date.now() - IMPROVEMENTS_TIMEOUT_MS - 1000 });
  const stale = await getOperation(accepted.operationId);
  assert.equal(stale.state, 'unknown');
  assert.equal(stale.lifecycle.state, 'unknown');
  assert.equal(stale.lifecycle.failure.code, 'IMPROVEMENTS_OUTCOME_UNAVAILABLE');
  assert.equal(stale.retryAfterSeconds, undefined);
});
