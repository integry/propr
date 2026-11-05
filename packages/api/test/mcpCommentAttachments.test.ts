import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import sharp from 'sharp';
import { closeConnection } from '@propr/core';
import { McpError } from '../mcp/config.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { projectDiscussionComment } from '../mcp/reviewDiscussion.js';
import { McpStore } from '../mcp/store.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';
import { parseCommentAttachments } from '../services/commentAttachmentFetch.js';

after(closeConnection);

const repository = 'acme/repo';
const attachment = (asset: string) => `https://github.com/user-attachments/assets/${asset}`;
const commentBody = `Here is the broken layout:

![Settings page](${attachment('shot-1')})

<img width="400" alt="Mobile view" src="${attachment('shot-2')}" />

${attachment('clip-1')}

<video src="${attachment('clip-2')}"></video>

Not an attachment: https://example.com/user-attachments/assets/evil and ${attachment('shot-1')} again.`;

function actor(github: McpPrincipal['github'], accessToken: string | null = 'caller-token'): McpPrincipal {
  return {
    user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken },
    authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant', ownerId: '123', clientId: 'client', clientName: 'Test', instanceId: 'test-instance',
      resource: 'https://instance.example/api/mcp', scopes: ['read'], repositories: [repository], createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
    scopes: ['read'],
    github,
  } as McpPrincipal;
}

test('parseCommentAttachments discovers only GitHub user attachments, classified by how they are embedded', () => {
  assert.deepEqual(parseCommentAttachments(commentBody), [
    { index: 0, attachmentId: 'shot-1', url: attachment('shot-1'), type: 'image', alt: 'Settings page' },
    { index: 1, attachmentId: 'shot-2', url: attachment('shot-2'), type: 'image', alt: 'Mobile view' },
    { index: 2, attachmentId: 'clip-1', url: attachment('clip-1'), type: 'unknown', alt: '' },
    { index: 3, attachmentId: 'clip-2', url: attachment('clip-2'), type: 'video', alt: '' },
  ]);
  assert.deepEqual(parseCommentAttachments(`${attachment('a')}/../../x ${attachment('b')}?x=1`), []);
  assert.deepEqual(parseCommentAttachments(null), []);
  assert.equal(parseCommentAttachments(Array.from({ length: 30 }, (_, i) => attachment(`a${i}`)).join('\n')).length, 20);
});

test('get_comment_attachment returns bounded image content through the caller GitHub credential', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async () => { /* GitHub repository authorization is independent of media fetches. */ };

  const requests: Array<{ route: string; params: Record<string, unknown> }> = [];
  const github = { request: async (route: string, params: Record<string, unknown>) => {
    requests.push({ route, params });
    if (route.includes('/issues/comments/')) {
      return { data: { body: commentBody, body_html: '', issue_url: `https://api.github.com/repos/${repository}/issues/${params.comment_id === 900 ? 7 : 49}`,
        html_url: `https://github.com/${repository}/pull/49#issuecomment-${params.comment_id}` } };
    }
    return { data: { body: `Description ![Design](${attachment('design')})`, body_html: '', html_url: `https://github.com/${repository}/issues/${params.issue_number}` } };
  } } as unknown as McpPrincipal['github'];

  const source = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#d83a67' } }).png().toBuffer();
  const fetched: string[] = [];
  const responses: Record<string, () => Response> = {
    'shot-1': () => new Response(null, { status: 302, headers: { Location: 'https://private-user-images.githubusercontent.com/1/shot-1.png?jwt=signed' } }),
    'clip-1': () => new Response('video', { status: 200, headers: { 'Content-Type': 'video/mp4' } }),
    'shot-2': () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    design: () => new Response(source, { status: 200, headers: { 'Content-Type': 'image/png' } }),
  };
  const deps: ToolDeps = {
    db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never,
    visualPreviews: {
      reader: { enabledRepositories: async () => new Set() },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        fetched.push(url.href);
        const authorization = new Headers(init?.headers).get('authorization');
        if (url.hostname === 'github.com') {
          assert.equal(authorization, 'Bearer caller-token');
          return responses[url.pathname.split('/').at(-1)!]();
        }
        // Signed redirect hosts never receive the caller's GitHub credential.
        assert.equal(authorization, null);
        return new Response(source, { status: 200, headers: { 'Content-Type': 'image/png' } });
      },
    },
  };
  const principal = actor(github);
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'get_comment_attachment')!;
  assert.equal(tool.readOnly, true);
  assert.equal(tool.scope, 'read');

  // Works without previews enabled or any managed storage: only GitHub is consulted.
  const result = await executeTool(tool, { repository, pullRequest: 49, commentId: 700 }, principal, deps);
  const image = result.content![0] as { type: string; data: string; mimeType: string };
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/webp');
  const rendered = Buffer.from(image.data, 'base64');
  assert.ok(rendered.byteLength <= 750 * 1024);
  const metadata = await sharp(rendered).metadata();
  assert.equal(Math.max(metadata.width!, metadata.height!), 1024);
  assert.deepEqual(result.data, {
    repository, number: 49, commentId: 700, attachmentIndex: 0, attachmentId: 'shot-1', alt: 'Settings page',
    url: attachment('shot-1'), commentUrl: `https://github.com/${repository}/pull/49#issuecomment-700`,
    width: 1024, height: 683, originalBytes: source.byteLength, bytes: rendered.byteLength, mimeType: 'image/webp',
  });
  assert.deepEqual(fetched, [attachment('shot-1'), 'https://private-user-images.githubusercontent.com/1/shot-1.png?jwt=signed']);

  // The description is read when commentId is omitted; format and size are honored.
  const described = await executeTool(tool, { repository, issue: 12, attachmentId: 'design', maxDimension: 256, format: 'png' }, principal, deps);
  assert.equal((described.content![0] as { mimeType: string }).mimeType, 'image/png');
  assert.equal((described.data as { width: number }).width, 256);
  assert.equal(requests.at(-1)!.route, 'GET /repos/{owner}/{repo}/issues/{issue_number}');
  assert.deepEqual((requests.at(-1)!.params as { mediaType: unknown }).mediaType, { format: 'full' });

  const rejects = (args: Record<string, unknown>, code: string, who = principal) => assert.rejects(executeTool(tool, { repository, ...args }, who, deps),
    (error: unknown) => error instanceof McpError && error.code === code);

  // Videos stay metadata-only: an embedded <video> is never downloaded, a bare link is cancelled on its content type.
  const before = fetched.length;
  await rejects({ pullRequest: 49, commentId: 700, attachmentIndex: 3 }, 'PREVIEW_NOT_RENDERABLE');
  assert.equal(fetched.length, before);
  await rejects({ pullRequest: 49, commentId: 700, attachmentId: 'clip-1' }, 'PREVIEW_NOT_RENDERABLE');
  await rejects({ pullRequest: 49, commentId: 700, attachmentId: 'shot-2' }, 'PREVIEW_NOT_RENDERABLE');
  await rejects({ pullRequest: 49, commentId: 700, attachmentIndex: 9 }, 'ATTACHMENT_NOT_FOUND');
  await rejects({ pullRequest: 49, commentId: 700, attachmentId: 'evil' }, 'ATTACHMENT_NOT_FOUND');
  // A repository-wide comment id must belong to the named pull request.
  await rejects({ pullRequest: 49, commentId: 900 }, 'ATTACHMENT_NOT_FOUND');
  // Exactly one discussion target and at most one attachment selector are accepted.
  await assert.rejects(executeTool(tool, { repository, commentId: 700 }, principal, deps));
  await assert.rejects(executeTool(tool, { repository, pullRequest: 49, issue: 49 }, principal, deps));
  await assert.rejects(executeTool(tool, { repository, pullRequest: 49, attachmentIndex: 0, attachmentId: 'shot-1' }, principal, deps));
  await rejects({ pullRequest: 49, commentId: 700 }, 'GITHUB_CREDENTIAL_REQUIRED', actor(github, null));
});

test('discussion comments list their fetchable attachments', async () => {
  const projected = await projectDiscussionComment({} as ToolDeps, {
    id: 700, body: commentBody, html_url: 'https://github.com/acme/repo/pull/49#issuecomment-700', created_at: new Date().toISOString(), user: { login: 'designer' },
  }, { repository, pullRequest: 49, head: 'a'.repeat(40), bodyOffset: 0 });
  assert.deepEqual(projected.attachments, [
    { index: 0, attachmentId: 'shot-1', type: 'image', alt: 'Settings page', fetchable: true },
    { index: 1, attachmentId: 'shot-2', type: 'image', alt: 'Mobile view', fetchable: true },
    { index: 2, attachmentId: 'clip-1', type: 'unknown', alt: '', fetchable: true },
    { index: 3, attachmentId: 'clip-2', type: 'video', alt: '', fetchable: false },
  ]);
  const plain = await projectDiscussionComment({} as ToolDeps, {
    id: 701, body: 'No media here.', html_url: 'https://github.com/acme/repo/pull/49#issuecomment-701', created_at: new Date().toISOString(), user: null,
  }, { repository, pullRequest: 49, head: 'a'.repeat(40), bodyOffset: 0 });
  assert.equal('attachments' in plain, false);
});
