import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { McpError } from '../mcp/config.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { McpStore } from '../mcp/store.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';

after(closeConnection);

const repository = 'acme/repo';
const head = 'a'.repeat(40);

/** GitHub stores code review apart from the conversation: three endpoints, three record sets. */
const conversation = [{ id: 11, body: 'Thanks, merging after CI.', html_url: 'https://github.com/acme/repo/pull/42#issuecomment-11', created_at: '2026-11-01T00:00:00Z', user: { login: 'maintainer' } }];
const reviews = [
  { id: 21, state: 'CHANGES_REQUESTED', body: 'Please reuse the shared retry helper.', html_url: 'https://github.com/acme/repo/pull/42#pullrequestreview-21', submitted_at: '2026-11-01T01:00:00Z', commit_id: head, user: { login: 'reviewer' } },
  { id: 22, state: 'APPROVED', body: '', html_url: 'https://github.com/acme/repo/pull/42#pullrequestreview-22', submitted_at: '2026-11-01T02:00:00Z', commit_id: head, user: { login: 'reviewer' } },
  { id: 23, state: 'COMMENTED', body: 'x'.repeat(5000), html_url: 'https://github.com/acme/repo/pull/42#pullrequestreview-23', submitted_at: '2026-11-01T03:00:00Z', commit_id: head, user: { login: 'reviewer' } },
];
const inline = [
  { id: 31, body: 'Do not log the token here.', html_url: 'https://github.com/acme/repo/pull/42#discussion_r31', created_at: '2026-11-01T01:00:00Z', user: { login: 'reviewer' },
    path: 'src/auth.ts', line: 18, side: 'RIGHT', pull_request_review_id: 21, commit_id: head },
  { id: 32, body: 'Done.', html_url: 'https://github.com/acme/repo/pull/42#discussion_r32', created_at: '2026-11-01T01:30:00Z', user: { login: 'author' },
    path: 'src/auth.ts', line: null, original_line: 18, side: 'RIGHT', in_reply_to_id: 31, pull_request_review_id: 24, commit_id: head },
];

function page<T>(items: T[], params: Record<string, unknown>): T[] {
  const perPage = Number(params.per_page);
  const start = (Number(params.page) - 1) * perPage;
  return items.slice(start, start + perPage);
}

test('get_pull_request_discussion pages submitted reviews and inline review comments the conversation omits', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async () => { /* Repository authorization is covered by the policy suites. */ };
  const requests: Array<{ route: string; params: Record<string, unknown> }> = [];
  const github = { request: async (route: string, params: Record<string, unknown>) => {
    requests.push({ route, params });
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { number: 42, head: { sha: head } } };
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return { data: page(conversation, params) };
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews') return { data: page(reviews, params) };
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') return { data: page(inline, params) };
    throw new Error(`Unexpected GitHub request: ${route}`);
  } } as unknown as McpPrincipal['github'];
  const principal = {
    user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'caller-token' },
    authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant', ownerId: '123', clientId: 'client', clientName: 'Test', instanceId: 'test-instance',
      resource: 'https://instance.example/api/mcp', scopes: ['read'], repositories: [repository], createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
    scopes: ['read'],
    github,
  } as McpPrincipal;
  const deps = { db, policy, taskQueue: {} as never, redisClient: { sMembers: async () => [] } as never, runtimeBuildQueue: {} as never } as ToolDeps;
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'get_pull_request_discussion')!;
  const call = async (args: Record<string, unknown>) => (await executeTool(tool, { repository, pullRequest: 42, ...args }, principal, deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  // The default source is the conversation and contains no code review at all.
  const talk = await call({});
  assert.equal(talk.source, 'conversation');
  assert.deepEqual(talk.comments.map((comment: { id: number }) => comment.id), [11]);

  // Submitted reviews page by number until a short page.
  const first = await call({ source: 'reviews', limit: 2 });
  assert.equal(first.source, 'reviews');
  assert.equal(first.head, head);
  assert.deepEqual(first.comments.map((review: { id: number }) => review.id), [21, 22]);
  assert.deepEqual(first.comments[0], { id: 21, kind: 'review', url: reviews[0].html_url, author: 'reviewer', createdAt: '2026-11-01T01:00:00Z',
    state: 'CHANGES_REQUESTED', commitId: head, body: 'Please reuse the shared retry helper.', nextBodyOffset: null });
  assert.equal(first.nextPage, 2);
  const second = await call({ source: 'reviews', limit: 2, page: 2 });
  assert.deepEqual(second.comments.map((review: { id: number }) => review.id), [23]);
  assert.equal(second.comments[0].body.length, 4096);
  assert.equal(second.comments[0].nextBodyOffset, 4096);
  assert.equal(second.nextPage, null);
  assert.equal((await call({ source: 'reviews', limit: 2, page: 2, bodyOffset: 4096 })).comments[0].body.length, 904);

  // Inline comments keep their file, line and reply thread; an outdated comment falls back to its original line.
  const lines = await call({ source: 'review_comments', limit: 10 });
  assert.deepEqual(lines.comments, [
    { id: 31, kind: 'review_comment', url: inline[0].html_url, author: 'reviewer', createdAt: '2026-11-01T01:00:00Z', path: 'src/auth.ts', line: 18, side: 'RIGHT',
      reviewId: 21, inReplyToId: null, commitId: head, body: 'Do not log the token here.', nextBodyOffset: null },
    { id: 32, kind: 'review_comment', url: inline[1].html_url, author: 'author', createdAt: '2026-11-01T01:30:00Z', path: 'src/auth.ts', line: 18, side: 'RIGHT',
      reviewId: 24, inReplyToId: 31, commitId: head, body: 'Done.', nextBodyOffset: null },
  ]);
  assert.equal(lines.nextPage, null);
  const inlineRead = requests.find(item => item.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments')!;
  assert.deepEqual({ ...inlineRead.params }, { owner: 'acme', repo: 'repo', pull_number: 42, page: 1, per_page: 10, sort: 'created', direction: 'asc' });

  // Review sources page by number only; conversation-only selectors are refused, not ignored.
  for (const args of [{ order: 'newest' }, { commentId: 31 }, { taskId: 'task-1' }]) {
    await assert.rejects(call({ source: 'review_comments', ...args }), (error: unknown) => error instanceof McpError && error.code === 'INVALID_INPUT');
  }
});
