import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
      if (repository === 'acme/forbidden') throw Object.assign(new Error('Forbidden'), { status: 403 });
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
