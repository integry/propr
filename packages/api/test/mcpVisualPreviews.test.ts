import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import knex from 'knex';
import sharp from 'sharp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { closeConnection } from '@propr/core';
import { McpError } from '../mcp/config.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { buildMcpServer } from '../mcp/server.js';
import { McpStore } from '../mcp/store.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';

after(closeConnection);

const repository = 'acme/repo';
const imageAsset = 'image-asset';
const videoAsset = 'video-asset';
const titleSecret = 'github_pat_titleSecret123';
const descriptionSecret = 'ghp_descriptionSecret123';
const attachment = (asset: string) => `https://github.com/user-attachments/assets/${asset}`;
const published = `<!-- propr-visual-preview -->
### Dashboard ${titleSecret}

![Dashboard](${attachment(imageAsset)})

Rendered ${descriptionSecret} dashboard.

### Walkthrough

![](${attachment(videoAsset)})`;

function actor(github: McpPrincipal['github']): McpPrincipal {
  return {
    user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'caller-token' },
    authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant', ownerId: '123', clientId: 'client', clientName: 'Test', instanceId: 'test-instance',
      resource: 'https://instance.example/api/mcp', scopes: ['read'], repositories: [repository], createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
    scopes: ['read'],
    github,
  };
}

test('visual preview tools list task-scoped media and return bounded image blocks to both protocol eras', async t => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async () => { /* GitHub repository authorization is independent of media fetches. */ };
  let previewsEnabled = true;
  let githubCalls = 0;
  let fetchCalls = 0;
  const github = { request: async (route: string) => {
    githubCalls += 1;
    return { data: { body: published, body_html: '', html_url: route.includes('comments')
      ? `https://github.com/${repository}/pull/49#issuecomment-700` : `https://github.com/${repository}/pull/49` } };
  } } as McpPrincipal['github'];
  const source = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#3a67d8' } }).png().toBuffer();
  const deps: ToolDeps = {
    db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never,
    visualPreviews: {
      reader: { enabledRepositories: async () => new Set(previewsEnabled ? [repository] : []) },
      fetch: async (_url, init) => {
        fetchCalls += 1;
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer caller-token');
        return new Response(source, { status: 200, headers: { 'Content-Type': 'image/png' } });
      },
    },
  };
  const principal = actor(github);
  const catalog = createToolCatalog(deps);
  const tool = (name: string) => catalog.find(candidate => candidate.name === name)!;

  const listed = await executeTool(tool('list_visual_previews'), { repository, pullRequest: 49 }, principal, deps);
  assert.deepEqual((listed.data as { previews: unknown[] }).previews, [
    { previewId: 'pull:49:image-asset', type: 'image', title: 'Dashboard [redacted]', description: 'Rendered [redacted] dashboard.', fetchable: true },
    { previewId: 'pull:49:video-asset', type: 'video', title: 'Walkthrough', description: '', fetchable: false },
  ]);

  await db('tasks').insert({ task_id: 'follow-up', repository, task_type: 'pr-comment', pr_number: 49 });
  await db('task_history').insert({ task_id: 'follow-up', state: 'completed', metadata: JSON.stringify({ githubComment: {
    body: published, url: `https://github.com/${repository}/pull/49#issuecomment-700`,
  } }) });
  const followUp = await executeTool(tool('list_visual_previews'), { repository, taskId: 'follow-up' }, principal, deps);
  assert.deepEqual((followUp.data as { association: unknown }).association, { kind: 'comment', repository, number: 700 });

  await db('tasks').insert({ task_id: 'private-goal-task', repository, task_type: 'goal', pr_number: 49 });
  await db('goals').insert({
    goal_id: '00000000-0000-4000-8000-000000000099', owner_id: '999', owner_login: 'other', repository,
    objective: 'Private goal', launch_strategy: 'direct', initial_prompt: 'Private', agent_id: 'codex', agent_alias: 'codex',
    agent_type: 'codex', requested_model: 'gpt-5.6', current_task_id: 'private-goal-task',
  });
  const callsBeforePrivateTask = githubCalls;
  await assert.rejects(executeTool(tool('list_visual_previews'), { repository, taskId: 'private-goal-task' }, principal, deps),
    (error: unknown) => error instanceof McpError && error.code === 'NOT_FOUND');
  assert.equal(githubCalls, callsBeforePrivateTask);

  previewsEnabled = false;
  const callsBeforeDisabled = githubCalls;
  const disabled = await executeTool(tool('list_visual_previews'), { repository, pullRequest: 49 }, principal, deps);
  assert.deepEqual(disabled.data, { association: { kind: 'pull', repository, number: 49 }, previews: [], previewsEnabled: false });
  await assert.rejects(executeTool(tool('get_visual_preview'), { repository, previewId: 'pull:49:image-asset' }, principal, deps),
    (error: unknown) => error instanceof McpError && error.code === 'PREVIEWS_DISABLED' && error.stage === 'validation');
  assert.equal(githubCalls, callsBeforeDisabled);
  previewsEnabled = true;

  await assert.rejects(executeTool(tool('get_visual_preview'), { repository, previewId: 'pull:49:video-asset' }, principal, deps),
    (error: unknown) => error instanceof McpError && error.code === 'PREVIEW_NOT_RENDERABLE'
      && error.stage === 'validation' && error.message.includes(`https://github.com/${repository}/pull/49`));
  assert.equal(fetchCalls, 0);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.all('/api/mcp', async (req, res) => {
    const handler = createMcpHandler(() => buildMcpServer(principal, deps, catalog), { legacy: 'stateless' });
    try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
  });
  const server = createServer(app);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
  const base64Lengths: number[] = [];

  for (const modern of [true, false]) {
    const client = modern
      ? new Client({ name: 'preview-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
      : new LegacyClient({ name: 'preview-test-legacy', version: '1' });
    const transport = modern ? new StreamableHTTPClientTransport(endpoint) : new LegacyTransport(endpoint);
    await client.connect(transport as never);
    try {
      const result = await client.callTool({ name: 'get_visual_preview', arguments: { repository, previewId: 'pull:49:image-asset' } });
      assert.notEqual(result.isError, true);
      const image = result.content[0] as { type: string; data: string; mimeType: string };
      assert.equal(image.type, 'image');
      assert.equal(image.mimeType, 'image/webp');
      base64Lengths.push(Buffer.byteLength(image.data));
      const rendered = Buffer.from(image.data, 'base64');
      assert.ok(rendered.byteLength <= 750 * 1024);
      const metadata = await sharp(rendered).metadata();
      assert.equal(Math.max(metadata.width!, metadata.height!), 1024);
      const details = JSON.parse((result.content[1] as { text: string }).text);
      assert.equal(details.originalBytes, source.byteLength);
      assert.equal(details.bytes, rendered.byteLength);
      assert.equal(details.title, 'Dashboard [redacted]');
      assert.equal(details.description, 'Rendered [redacted] dashboard.');
      assert.ok(!JSON.stringify(details).includes(titleSecret));
      assert.ok(!JSON.stringify(details).includes(descriptionSecret));
      const structured = result.structuredContent as { data: Record<string, unknown> };
      assert.deepEqual(details, structured.data);
      assert.ok(!JSON.stringify(structured).includes(titleSecret));
      assert.ok(!JSON.stringify(structured).includes(descriptionSecret));
      const resource = await client.readResource({ uri: 'propr://instances/test-instance/repositories/acme/repo/previews/pull:49:image-asset' });
      assert.equal(resource.contents[0].mimeType, 'image/webp');
      assert.ok('blob' in resource.contents[0]);
    } finally { await client.close(); }
  }

  assert.equal(fetchCalls, 4);
  const imageRows = await db('mcp_access_log').where({ name: 'get_visual_preview', outcome: 'success' }).orderBy('id').select('result_bytes');
  assert.deepEqual(imageRows.map(row => Number(row.result_bytes)), base64Lengths);
});
