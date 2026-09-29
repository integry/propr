import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import knex from 'knex';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { closeConnection } from '@propr/core';
import { McpError } from '../mcp/config.js';
import type { McpPrincipal } from '../mcp/policy.js';
import { buildMcpServer } from '../mcp/server.js';
import { createToolCatalog, type McpTool, type ToolDeps } from '../mcp/tools.js';
import { getIndexedDoc, loadDocsIndex, normalizeDocContent } from '../mcp/docsIndex.js';

after(() => closeConnection());

const longParagraph = 'Ultrafix reviews the current pull request, fixes findings, and checks the requested goal before deciding whether to stop. '.repeat(12).trim();
const commandsSource = `---
sidebar_position: 2
title: PR Comment Commands
---

import Screenshot from '@site/src/components/Screenshot';

# PR Comment Commands

Most PR refinement starts with a normal comment and a clear requested outcome.

{/* screenshot placeholder that must not be served */}

## Quick Reference

Use the command that matches the intended operation.

### \`/ultrafix\`

Ultrafix alternates review and fix cycles until its latest review reaches the configured goal.

${longParagraph}

${longParagraph}

\`\`\`ts
import example from 'kept-inside-a-code-fence';
\`\`\`

### \`/merge\`

Merge the base branch into the pull request branch.
`;

const overviewSource = `---
sidebar_position: 1
---
# Feature Overview

An overview of the major ProPR workflows.
`;

const deploymentSource = `---
title: Deployment
---

Keep the rollback procedure close at hand before making changes.

## Installation

Install the current release.
`;

const headinglessSource = `---
title: Glossary
---

A frobnicator is a headingless concept that remains searchable.
`;

const sensitiveSource = `${'a'.repeat(996)} ghp_exampletoken tail

## Credential ghp_headertoken

Searchable ghp_bodytoken value.
`;

const jsonContinuationSource = `# Example

${'a'.repeat(985)}

{"password": "<set locally>", "retries": 3}
`;

const duplicateHeadingsSource = `# Operations

## Local

### Troubleshooting

Restart the local process.

## Hosted

### Troubleshooting

Inspect the quasar relay before retrying the hosted operation.
`;

function tool(catalog: McpTool[], name: string): McpTool {
  const found = catalog.find(candidate => candidate.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

async function call(catalog: McpTool[], name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const selected = tool(catalog, name);
  const result = await selected.run({ principal: {} as McpPrincipal, args: selected.schema.parse(args) });
  assert.equal(result.status, 200);
  return result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test('MCP docs tools discover, normalize, page, search and safely serve bundled docs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'propr-mcp-docs-'));
  const previousRoot = process.env.PROPR_DOCS_DIR;
  process.env.PROPR_DOCS_DIR = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.PROPR_DOCS_DIR;
    else process.env.PROPR_DOCS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'docs', 'features'), { recursive: true });
  await mkdir(join(root, 'docs', 'operations'), { recursive: true });
  await writeFile(join(root, 'docs', 'features', 'pr-commands.md'), commandsSource);
  await writeFile(join(root, 'docs', 'features', 'overview.mdx'), overviewSource);
  await writeFile(join(root, 'docs', 'operations', 'deployment.md'), deploymentSource);
  await writeFile(join(root, 'docs', 'operations', 'glossary.md'), headinglessSource);
  await writeFile(join(root, 'docs', 'operations', 'json-continuation.md'), jsonContinuationSource);
  await writeFile(join(root, 'docs', 'operations', 'sensitive.md'), sensitiveSource);
  await writeFile(join(root, 'docs', 'operations', 'troubleshooting.md'), duplicateHeadingsSource);
  await writeFile(join(root, 'docs', 'operations', 'too-large.md'), Buffer.alloc(512 * 1024 + 1, 120));
  await writeFile(join(root, 'mcp.md'), '# MCP Guide\n\nConnect an MCP client to ProPR.\n');
  await writeFile(join(root, 'docs-manifest.json'), JSON.stringify({
    schemaVersion: 1, version: '9.8.7-test', sourceRevision: 'abc123',
    order: ['features/pr-commands', 'features/overview'],
  }));
  try {
    await symlink('/etc/passwd', join(root, 'docs', 'operations', 'linked.md'));
  } catch {
    // Some platforms disallow symlink creation; discovery remains covered by implementation review there.
  }

  const policy = {
    config: { instanceId: 'docs-test-instance', origin: 'https://instance.example', resource: 'https://instance.example/api/mcp' },
    requireScope: () => undefined,
    requirePermission: () => undefined,
  };
  const deps = { db: {} as never, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } as unknown as ToolDeps;
  const catalog = createToolCatalog(deps);

  const listed = await call(catalog, 'list_docs', { section: 'features', limit: 100 });
  assert.equal(listed.docsVersion, '9.8.7-test');
  assert.deepEqual(listed.pages.map((page: { path: string }) => page.path), ['features/pr-commands', 'features/overview']);
  assert.deepEqual(listed.pages[0], {
    path: 'features/pr-commands', title: 'PR Comment Commands', section: 'features',
    summary: 'Most PR refinement starts with a normal comment and a clear requested outcome.',
    words: listed.pages[0].words,
  });
  assert.ok(listed.pages[0].words > 100);
  assert.equal(listed.nextOffset, null);
  const all = await call(catalog, 'list_docs', { limit: 100 });
  assert.ok(all.pages.some((page: { path: string }) => page.path === 'mcp/guide'));
  assert.ok(!all.pages.some((page: { path: string }) => page.path.endsWith('too-large') || page.path.endsWith('linked')));

  const section = await call(catalog, 'get_doc', { path: 'features/pr-commands', section: '/ULTRAFIX', maxChars: 16000 });
  assert.match(section.content, /^### `\/ultrafix`/);
  assert.match(section.content, /configured goal/);
  assert.match(section.content, /kept-inside-a-code-fence/);
  assert.doesNotMatch(section.content, /### `\/merge`/);

  const expected = normalizeDocContent(commandsSource).content;
  let offset = 0;
  let reconstructed = '';
  let nextOffset: number | null = 0;
  while (nextOffset !== null) {
    const page = await call(catalog, 'get_doc', { path: 'features/pr-commands', offset, maxChars: 1000 });
    assert.ok(page.content.length <= 1000);
    assert.equal(page.offset, offset);
    reconstructed += page.content;
    nextOffset = page.nextOffset;
    if (nextOffset !== null) {
      assert.ok(nextOffset > offset);
      offset = nextOffset;
    }
  }
  assert.equal(reconstructed, expected);
  assert.doesNotMatch(reconstructed, /^---|sidebar_position|screenshot placeholder|Screenshot from/m);

  const searched = await call(catalog, 'search_docs', { query: 'ultrafix goal', limit: 20 });
  assert.equal(searched.results[0].path, 'features/pr-commands');
  assert.equal(searched.results[0].heading, '/ultrafix');
  assert.deepEqual(searched.results[0].section, { heading: '/ultrafix', offset: searched.results[0].section.offset });
  assert.ok(searched.results.every((result: { snippet: string }) => result.snippet.length <= 300));

  const introduction = await call(catalog, 'search_docs', { query: 'rollback', limit: 20 });
  assert.deepEqual(introduction.results[0], {
    path: 'operations/deployment', title: 'Deployment', heading: 'Deployment', section: null,
    snippet: 'Keep the rollback procedure close at hand before making changes.', score: 1,
  });
  const introductoryPage = await call(catalog, 'get_doc', { path: introduction.results[0].path });
  assert.match(introductoryPage.content, /rollback procedure/);

  const headingless = await call(catalog, 'search_docs', { query: 'frobnicator', limit: 20 });
  assert.equal(headingless.results[0].path, 'operations/glossary');
  assert.equal(headingless.results[0].section, null);
  const headinglessPage = await call(catalog, 'get_doc', { path: headingless.results[0].path });
  assert.match(headinglessPage.content, /headingless concept/);

  const duplicateHeading = await call(catalog, 'search_docs', { query: 'quasar relay', limit: 20 });
  assert.equal(duplicateHeading.results[0].heading, 'Troubleshooting');
  assert.ok(duplicateHeading.results[0].section);
  const duplicateSection = await call(catalog, 'get_doc', {
    path: duplicateHeading.results[0].path, section: duplicateHeading.results[0].section,
  });
  assert.match(duplicateSection.content, /quasar relay/);
  assert.doesNotMatch(duplicateSection.content, /local process/);

  await assert.rejects(
    tool(catalog, 'get_doc').run({ principal: {} as McpPrincipal, args: { path: '../../etc/passwd', offset: 0, maxChars: 8000 } }),
    (error: unknown) => error instanceof McpError && error.code === 'DOC_NOT_FOUND',
  );

  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('mcp_access_log', table => {
    table.increments('id');
    for (const name of ['owner_id', 'grant_id', 'client_id', 'client_name', 'membership_source', 'kind', 'name', 'repository',
      'scope', 'outcome', 'error_code', 'operation_id', 'protocol_version', 'request_id']) table.string(name);
    table.boolean('read_only');
    for (const name of ['occurred_at', 'status', 'duration_ms', 'result_bytes']) table.bigInteger(name);
  });
  const serverDeps = { ...deps, db } as ToolDeps;
  const principal = {
    user: { id: 'docs-user', username: 'docs-user' },
    scopes: ['read'],
    authorization: { permissions: [] },
    grant: { id: 'docs-grant', clientId: 'docs-client', clientName: 'Docs test', membershipSource: 'local', repositories: [] },
  } as unknown as McpPrincipal;
  const app = express();
  app.use(express.json());
  app.all('/api/mcp', async (req, res) => {
    const handler = createMcpHandler(() => buildMcpServer(principal, serverDeps, createToolCatalog(serverDeps)), { legacy: 'stateless' });
    try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
  });
  const http = createServer(app);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp`);
  const client = new Client({ name: 'docs-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url) as never);
  t.after(() => client.close());
  const protocolCall = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    return (result.structuredContent as { data: Record<string, any> }).data; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const wholeSensitive = await protocolCall('get_doc', { path: 'operations/sensitive', maxChars: 16000 });
  let sensitiveOffset = 0;
  let reconstructedSensitive = '';
  let sensitiveNextOffset: number | null = 0;
  while (sensitiveNextOffset !== null) {
    const page = await protocolCall('get_doc', { path: 'operations/sensitive', offset: sensitiveOffset, maxChars: 1000 });
    reconstructedSensitive += page.content;
    sensitiveNextOffset = page.nextOffset;
    if (sensitiveNextOffset !== null) {
      assert.ok(sensitiveNextOffset > sensitiveOffset);
      sensitiveOffset = sensitiveNextOffset;
    }
  }
  assert.equal(reconstructedSensitive, wholeSensitive.content);
  assert.doesNotMatch(reconstructedSensitive, /ghp_(?:example|header|body)token/);
  assert.equal(wholeSensitive.totalChars, wholeSensitive.content.length);

  const wholeJsonContinuation = await protocolCall('get_doc', { path: 'operations/json-continuation', maxChars: 16000 });
  const firstJsonPage = await protocolCall('get_doc', { path: 'operations/json-continuation', maxChars: 1000 });
  assert.equal(firstJsonPage.nextOffset, 998);
  const secondJsonPage = await protocolCall('get_doc', {
    path: 'operations/json-continuation', offset: firstJsonPage.nextOffset, maxChars: 1000,
  });
  assert.equal(secondJsonPage.content, '{"password": "<set locally>", "retries": 3}\n');
  assert.equal(firstJsonPage.content + secondJsonPage.content, wholeJsonContinuation.content);
  assert.equal(secondJsonPage.offset, firstJsonPage.nextOffset);
  assert.equal(secondJsonPage.totalChars, wholeJsonContinuation.content.length);

  const secretSearch = await protocolCall('search_docs', { query: 'headertoken' });
  assert.deepEqual(secretSearch.results, []);
  const credentialSearch = await protocolCall('search_docs', { query: 'credential' });
  const sensitiveHeading = credentialSearch.results.find((result: { path: string }) => result.path === 'operations/sensitive');
  assert.ok(sensitiveHeading);
  assert.deepEqual(sensitiveHeading.section, { heading: 'Credential [redacted]', offset: sensitiveHeading.section.offset });
  const sensitiveSection = await protocolCall('get_doc', { path: 'operations/sensitive', section: sensitiveHeading.section });
  assert.match(sensitiveSection.content, /^## Credential \[redacted\]/);

  const templates = await client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some(template => template.uriTemplate === 'propr://instances/docs-test-instance/docs/{+path}'));
  const resource = await client.readResource({ uri: 'propr://instances/docs-test-instance/docs/features/pr-commands' });
  const resourceBody = JSON.parse(String(resource.contents[0].text));
  assert.equal(resourceBody.data.path, 'features/pr-commands');
  assert.ok(resourceBody.data.content.length <= 8000);
  const jsonResource = await client.readResource({ uri: 'propr://instances/docs-test-instance/docs/operations/json-continuation' });
  const jsonResourceBody = JSON.parse(String(jsonResource.contents[0].text));
  assert.equal(jsonResourceBody.data.content, wholeJsonContinuation.content);
  assert.equal(jsonResourceBody.data.totalChars, wholeJsonContinuation.content.length);
});

test('normalization preserves fenced code while stripping document-level MDX wrappers', () => {
  const normalized = normalizeDocContent(`---\ntitle: Example\n---\nimport Outside from 'outside';\n{/* remove */}\n\`\`\`tsx\nimport Inside from 'inside';\n\`\`\`\n`);
  assert.equal(normalized.title, 'Example');
  assert.equal(normalized.content, "\n```tsx\nimport Inside from 'inside';\n```\n");
});

test('docs cache refresh fingerprints every indexed path instead of only the greatest timestamp', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const root = await mkdtemp(join(tmpdir(), 'propr-mcp-docs-refresh-'));
  const previousRoot = process.env.PROPR_DOCS_DIR;
  process.env.PROPR_DOCS_DIR = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.PROPR_DOCS_DIR;
    else process.env.PROPR_DOCS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  const changedFile = join(root, 'docs', 'changed.md');
  const newestFile = join(root, 'docs', 'newest.md');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(changedFile, '# Changed\n\nOld indexed body.\n');
  await writeFile(newestFile, '# Newest\n\nUnchanged body.\n');
  await utimes(changedFile, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  await utimes(newestFile, new Date('2040-01-01T00:00:00Z'), new Date('2040-01-01T00:00:00Z'));

  const initial = await loadDocsIndex();
  assert.match(getIndexedDoc(initial, 'changed').content, /Old indexed body/);

  await writeFile(changedFile, '# Changed\n\nNew indexed body.\n');
  await utimes(changedFile, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
  t.mock.timers.tick(60_001);

  const refreshed = await loadDocsIndex();
  assert.match(getIndexedDoc(refreshed, 'changed').content, /New indexed body/);
});
