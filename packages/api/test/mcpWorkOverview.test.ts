import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphqlResponseError } from '@octokit/graphql';
import knex from 'knex';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const repositories = ['acme/one', 'acme/two', 'acme/forbidden'];
const ownerId = '123';
const head42 = 'a'.repeat(40);
const head7 = 'b'.repeat(40);

const dataRoot = await mkdtemp(path.join(tmpdir(), 'propr-mcp-overview-'));
process.env.DATA_DIR = dataRoot;
process.env.DB_FILENAME = path.join(dataRoot, 'propr.sqlite');
process.env.NODE_ENV = 'test';
const core = await import('@propr/core');
const coreMock = await mock.module('@propr/core', { namedExports: {
  ...core,
  loadMonitoredReposRaw: async () => repositories.map(name => ({ name, enabled: true, baseBranch: 'main' })),
} });
after(async () => { coreMock.restore(); await core.closeConnection(); await rm(dataRoot, { recursive: true, force: true }); });

const { McpPolicy } = await import('../mcp/policy.js');
const { McpStore } = await import('../mcp/store.js');
const { McpOAuthProvider } = await import('../mcp/oauth.js');
const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
const { enrichPullRequests } = await import('../mcp/toolsWorkOverview.js');

function timestamp(millisecondsAgo: number): string {
  return new Date(Date.now() - millisecondsAgo).toISOString().replace('T', ' ').replace('Z', '');
}

const review = (head: string, score: number) => [
  `<!-- propr:ai-review head="${head}" -->`,
  '## Overall Evaluation',
  'The implementation is sound.',
  '## Merge blockers',
  'No merge blockers.',
  '## Suggestions',
  'These are optional follow-ups and are not sent to `/fix`.',
  'No suggestions.',
  '## Score',
  `Score: ${score}/10`,
].join('\n');

function graphqlResponseError(data: Json, types: string[]): GraphqlResponseError<Json> {
  const errors = types.map((type, index) => ({
    type, message: `${type} fixture`, path: ['repository', `pr_${index}`], extensions: {},
    locations: [{ line: 1, column: 1 }],
  }));
  return new GraphqlResponseError(
    { method: 'POST', url: 'https://api.github.com/graphql' } as never,
    {},
    { data, errors } as never,
  );
}

test('get_work_overview joins task work to bounded per-repository GraphQL enrichment', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    await db('tasks').insert([
      { task_id: 'active-42', repository: 'acme/one', task_type: 'issue', pr_number: 42, created_at: timestamp(120_000) },
      { task_id: 'active-7', repository: 'acme/two', task_type: 'issue', pr_number: 7, created_at: timestamp(110_000) },
      { task_id: 'active-no-pr', repository: 'acme/one', task_type: 'issue', created_at: timestamp(100_000) },
      { task_id: 'forbidden-9', repository: 'acme/forbidden', task_type: 'issue', pr_number: 9, created_at: timestamp(90_000) },
      { task_id: 'recent', repository: 'acme/one', task_type: 'issue', created_at: timestamp(30 * 60_000) },
      { task_id: 'old', repository: 'acme/one', task_type: 'issue', created_at: timestamp(180 * 60_000) },
    ]);
    await db('task_history').insert([
      { task_id: 'active-42', state: 'claude_execution', timestamp: timestamp(42_000) },
      { task_id: 'active-7', state: 'processing', timestamp: timestamp(7_000) },
      { task_id: 'active-no-pr', state: 'processing', timestamp: timestamp(30_000) },
      { task_id: 'forbidden-9', state: 'processing', timestamp: timestamp(9_000) },
      { task_id: 'recent', state: 'completed', timestamp: new Date(Date.now() - 30 * 60_000).toISOString() },
      { task_id: 'old', state: 'failed', timestamp: new Date(Date.now() - 120 * 60_000).toISOString() },
    ]);
    await db('notification_pull_request_state').insert({ repository: 'acme/forbidden', pr_number: 9, merged_at: new Date(Date.now() - 8_000).toISOString() });

    const graphqlCalls: Array<{ repository: string; query: string }> = [];
    const github = { graphql: async (query: string, args: Json) => {
      const repository = `${args.owner}/${args.repo}`;
      graphqlCalls.push({ repository, query });
      if (repository === 'acme/forbidden') {
        throw graphqlResponseError({ repository: null }, ['FORBIDDEN']);
      }
      const fixtures: Record<string, Record<number, Json>> = {
        'acme/one': { 42: { head: head42, score: 8, checks: 'SUCCESS', decision: 'APPROVED', labels: ['ultrafix'] } },
        'acme/two': { 7: { head: head7, score: 6, checks: 'PENDING', decision: 'REVIEW_REQUIRED', labels: [] } },
      };
      const response: Record<string, Json | null> = {};
      for (const match of query.matchAll(/pr_(\d+):pullRequest\(number:(\d+)\)/g)) {
        const number = Number(match[1]);
        const fixture = fixtures[repository]?.[number];
        response[`pr_${number}`] = fixture ? {
          number, url: `https://github.com/${repository}/pull/${number}`, state: 'OPEN', isDraft: false, merged: false,
          headRefOid: fixture.head, reviewDecision: fixture.decision, mergeStateStatus: 'CLEAN',
          labels: { nodes: fixture.labels.map((name: string) => ({ name })) },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: fixture.checks } } }] },
          comments: { nodes: [{ body: review(fixture.head, fixture.score), createdAt: timestamp(1_000) }] },
        } : null;
      }
      return { repository: response };
    } };
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'overview-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
    policy.repository = async () => {};
    const deps: ToolDeps = { db, policy, taskQueue: {} as never, runtimeBuildQueue: {} as never, redisClient: {} as never };
    const catalog = createToolCatalog(deps);
    const overview = catalog.find(tool => tool.name === 'get_work_overview') as McpTool;
    assert.ok(overview);
    const principal = { user: { id: ownerId, username: 'tester', login: 'tester' }, github,
      authorization: { role: 'member', source: 'local', permissions: [] }, scopes: ['read'],
      grant: { id: 'overview-grant', ownerId, clientId: 'client', clientName: 'Overview', instanceId: config.instanceId,
        resource: config.resource, scopes: ['read'], repositories, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
        revoked: false, membershipSource: 'local' } } as unknown as McpPrincipal;
    const call = async (args: Json) => (await executeTool(overview, args, principal, deps)).data as Json;

    const active = await call({ state: 'active', limit: 20 });
    assert.deepEqual(active.items.map((item: Json) => item.task.task_id), ['active-7', 'forbidden-9', 'active-no-pr', 'active-42']);
    assert.equal(graphqlCalls.filter(call => call.repository === 'acme/one').length, 1);
    assert.equal(graphqlCalls.filter(call => call.repository === 'acme/two').length, 1);
    assert.equal(graphqlCalls.filter(call => call.repository === 'acme/forbidden').length, 1);
    const one = active.items.find((item: Json) => item.task.task_id === 'active-42').pullRequest;
    assert.equal(one.reviewDecision, 'APPROVED');
    assert.deepEqual(one.checks, { state: 'SUCCESS' });
    assert.deepEqual(one.latestReview, { score: 8, reviewedHead: head42, matchesCurrentHead: true });
    assert.equal(one.latestReviewSearchTruncated, false);
    assert.equal(one.ultrafixActive, true);
    assert.equal(active.items.find((item: Json) => item.task.task_id === 'active-no-pr').pullRequest, null);
    assert.deepEqual(active.items.find((item: Json) => item.task.task_id === 'forbidden-9').pullRequest,
      { number: 9, state: 'merged', enrichment: 'unavailable' });
    assert.deepEqual(active.githubLookups, { requested: 3, completed: 2, truncated: false });

    const recent = await call({ state: 'recent', sinceMinutes: 60 });
    assert.deepEqual(recent.items.map((item: Json) => item.task.task_id), ['recent']);
  } finally {
    await db.destroy();
  }
});

test('get_work_overview preserves uncertainty when bounded PR metadata excludes older values', async () => {
  let query = '';
  const github = { graphql: async (document: string) => {
    query = document;
    return { repository: {
      pr_42: {
        number: 42, url: 'https://github.com/acme/one/pull/42', state: 'OPEN', isDraft: false, merged: false,
        headRefOid: head42, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN',
        labels: { pageInfo: { hasNextPage: true }, nodes: Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` })) },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
        comments: { pageInfo: { hasPreviousPage: true }, nodes: Array.from({ length: 10 }, (_, index) => ({
          body: `Ordinary discussion ${index}`, createdAt: timestamp(10_000 - index),
        })) },
      },
      pr_7: {
        number: 7, url: 'https://github.com/acme/one/pull/7', state: 'OPEN', isDraft: false, merged: false,
        headRefOid: head7, reviewDecision: null, mergeStateStatus: 'CLEAN',
        labels: { pageInfo: { hasNextPage: false }, nodes: [] },
        commits: { nodes: [] },
        comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      },
    } };
  } };
  const principal = { github } as unknown as McpPrincipal;

  const pulls = await enrichPullRequests(principal, 'acme/one', [42, 7]);
  const truncated = pulls.get(42);
  assert.ok(truncated);
  assert.equal(truncated.latestReview, null);
  assert.equal(truncated.latestReviewSearchTruncated, true);
  assert.equal(truncated.ultrafixActive, null);

  const complete = pulls.get(7);
  assert.ok(complete);
  assert.equal(complete.latestReview, null);
  assert.equal(complete.latestReviewSearchTruncated, false);
  assert.equal(complete.ultrafixActive, false);
  assert.match(query, /labels\(first:100\)\{pageInfo\{hasNextPage\}/);
  assert.match(query, /comments\(last:10\)\{pageInfo\{hasPreviousPage\}/);
});

test('get_work_overview preserves readable aliases from a NOT_FOUND GraphQL response', async () => {
  const github = { graphql: async () => {
    throw graphqlResponseError({ repository: {
      pr_42: {
        number: 42, url: 'https://github.com/acme/one/pull/42', state: 'OPEN', isDraft: false, merged: false,
        headRefOid: head42, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
        labels: { pageInfo: { hasNextPage: false }, nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
        comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      },
      pr_7: null,
    } }, ['NOT_FOUND']);
  } };
  const principal = { github } as unknown as McpPrincipal;

  const pulls = await enrichPullRequests(principal, 'acme/one', [42, 7]);
  assert.equal(pulls.get(42)?.head, head42);
  assert.equal(pulls.has(7), false);
});

test('get_work_overview propagates unrelated GraphQL response errors', async () => {
  const failure = graphqlResponseError({ repository: null }, ['INTERNAL']);
  const principal = { github: { graphql: async () => { throw failure; } } } as unknown as McpPrincipal;

  await assert.rejects(enrichPullRequests(principal, 'acme/one', [42]), failure);
});

test('get_work_overview paginates mixed timestamp formats by normalized activity', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
    const day = new Date().toISOString().slice(0, 10);
    await db('tasks').insert([
      { task_id: 'older-completed', repository: 'acme/one', task_type: 'issue', created_at: `${day} 08:00:00.000` },
      { task_id: 'newer-active', repository: 'acme/one', task_type: 'issue', created_at: `${day} 08:00:00.000` },
    ]);
    await db('task_history').insert([
      { task_id: 'older-completed', state: 'completed', timestamp: `${day}T09:00:00.000Z` },
      { task_id: 'newer-active', state: 'processing', timestamp: `${day} 16:00:00.000` },
    ]);

    const github = { graphql: async () => { throw new Error('No pull requests should be enriched.'); } };
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'overview-order-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
    policy.repository = async () => {};
    const deps: ToolDeps = { db, policy, taskQueue: {} as never, runtimeBuildQueue: {} as never, redisClient: {} as never };
    const overview = createToolCatalog(deps).find(tool => tool.name === 'get_work_overview') as McpTool;
    const principal = { user: { id: ownerId, username: 'tester', login: 'tester' }, github,
      authorization: { role: 'member', source: 'local', permissions: [] }, scopes: ['read'],
      grant: { id: 'overview-order-grant', ownerId, clientId: 'client', clientName: 'Overview', instanceId: config.instanceId,
        resource: config.resource, scopes: ['read'], repositories: ['acme/one'], createdAt: Date.now(), expiresAt: Date.now() + 60_000,
        revoked: false, membershipSource: 'local' } } as unknown as McpPrincipal;

    const result = (await executeTool(overview, {
      repository: 'acme/one', state: 'all', sinceMinutes: 1440, limit: 1,
    }, principal, deps)).data as Json;

    assert.deepEqual(result.items.map((item: Json) => item.task.task_id), ['newer-active']);
  } finally {
    await db.destroy();
  }
});
