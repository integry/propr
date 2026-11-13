import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installSettingsFixture } from './settings-layout.fixture';

const instanceId = 'c63a25da-fd5e-4a46-8fe1-566136e12289';
const allowAll = { repositories: [] as string[], agents: [] as string[], autoApply: true };
const emptyLibrary = { version: 1, instanceId, revision: 0, servers: [], skills: [], secrets: {}, skillBundles: [], createdAt: 0, updatedAt: 0, auditActor: '' };

test('instance extension library describes skills and MCP servers, shows immutable provenance and write-only authentication', async ({ page }) => {
  await installSettingsFixture(page);
  const library = {
    version: 1, instanceId, revision: 3,
    servers: [{ kind: 'https', name: 'documentation', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search', 'read_document'], capability: 'read', authentication: 'bearer', repositories: ['example/docs'], agents: ['claude-main', 'codex-main'], autoApply: true }],
    skills: [{ bundleId: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', enabled: true, ...allowAll }],
    secrets: { documentation: { fields: ['bearerToken'], configured: true } },
    skillBundles: [{ id: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', instanceId, name: 'documentation-review', digest: 'd853bea9e15d14bc3881f84dd19a2cb940624fda943e677e6b6ac9cc31ff1009', files: 3, bytes: 8120, requirements: ['documentation.search'], source: { kind: 'github', repository: 'example/skills', commit: 'd66d0ad62a789374f81f7e1c4f5dbcc43319e1a6', directory: 'skills/documentation-review' }, createdAt: 1791907200000, auditActor: '1' }],
    createdAt: 1791907200000, updatedAt: 1791907200000, auditActor: '1',
  };
  await page.route('**/api/instance/extensions/v1**', route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { revisions: [library] } });
    if (url.pathname.endsWith('/validate')) return route.fulfill({ json: { results: [{ name: 'documentation', reachable: true, status: 'reachable' }, { name: 'operator-documentation', reachable: null, status: 'not_validated' }] } });
    if (request.method() === 'POST') {
      expect(request.headers()['x-propr-extensions']).toBe('1');
      expect(url.pathname.endsWith('/library')).toBe(true);
      expect(request.postDataJSON().expectedRevision).toBe(3);
      return route.fulfill({ json: { library: { ...library, ...request.postDataJSON().input, revision: 4 } } });
    }
    return route.fulfill({ json: { instanceId, library, bundles: [], catalog: [{ id: 'operator-documentation', digest: 'a'.repeat(64), tools: ['lookup', 'update_document'], capability: 'write', secrets: { count: 1, configured: true } }] } });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=agent-extensions');
  const section = page.getByRole('region', { name: 'Skills & MCP servers', exact: true });
  await expect(section).toBeVisible();
  await expect(section.getByText(/Give agents extra tools for a task/)).toContainText('Only Claude and Codex runs can use extensions.');
  await expect(section.getByText(/Revision 3 · updated/)).toBeVisible();
  const password = section.getByLabel(/Replace bearer token/);
  await expect(password).toHaveValue('');
  await expect(section.getByText('(configured; write-only)', { exact: true })).toBeVisible();
  await expect(section.getByText(/SHA-256 d853bea/)).toBeVisible();
  await section.getByRole('button', { name: 'Validate saved MCP connectivity' }).click();
  await expect(section.getByRole('status')).toHaveText('documentation: reachable · operator-documentation: not validated');
  await section.getByRole('button', { name: 'Revision history' }).click();
  await expect(section.getByText(/Revision 3.*administrator 1/)).toBeVisible();
  await section.getByLabel('Add operator catalog entry').selectOption('operator-documentation');
  await expect(section.getByText('Operator catalog entry: operator-documentation')).toBeVisible();
  await expect(section.getByText('Operator secrets: configured', { exact: true })).toBeVisible();
  const catalogServer = section.getByTestId('extension-server').nth(1);
  await expect(catalogServer.getByRole('checkbox', { name: /Apply automatically/ })).toBeChecked();
  await expect(catalogServer.getByLabel('lookup', { exact: true })).toBeChecked();
  await expect(catalogServer.getByLabel('update_document', { exact: true })).toBeChecked();
  await expect(catalogServer.getByLabel(/^Capability/)).toHaveValue('write');
  await expect(catalogServer.getByLabel(/^Capability/)).toBeDisabled();
  await catalogServer.getByLabel('update_document', { exact: true }).uncheck();
  const saveRequest = page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/api/instance/extensions/v1'));
  await section.getByRole('button', { name: 'Save library' }).click();
  const descriptor = (await saveRequest).postDataJSON().input.servers[1];
  expect(descriptor).toEqual({ kind: 'catalog', name: 'server-1', catalogId: 'operator-documentation', digest: 'a'.repeat(64), enabled: true, tools: ['lookup'], capability: 'write', ...allowAll });
  await expect(section.getByRole('status')).toHaveText('Extension library saved.');
  await expect(section.getByText(/Revision 4 · updated/)).toBeVisible();
  expect(await section.textContent()).not.toMatch(/API_KEY|OPERATOR_DOCS_KEY|UNMISTAKABLE|CATALOG_ARGUMENT_SENTINEL|CATALOG_PATH_SENTINEL|\/usr\/bin\/env/);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.setViewportSize({ width: 1280, height: 1900 });
    await section.scrollIntoViewIfNeeded();
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await section.getByRole('button', { name: 'Validate saved MCP connectivity' }).click();
    await expect(section.getByRole('status')).toContainText('operator-documentation: not validated');
    await section.getByRole('status').screenshot({ path: path.join(directory, 'extension-validation-status.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/extension-validation-status.png', title: 'Catalog validation status', description: 'Saved MCP validation distinguishes catalog entries that have not been validated from unavailable endpoints.' },
    ], toolSuggestions: [] }));
  }
});


test('New Task shows the library items that apply, offers the write opt-in and the disable switch, and never reads the admin library', async ({ page }) => {
  await installSettingsFixture(page);
  let libraryRequests = 0;
  const previews: string[] = [];
  const submissions: { payload: Record<string, unknown>; header?: string }[] = [];
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: { agents: [{ id: 'claude', kind: 'direct', alias: 'claude', enabled: true, supportedModels: ['claude-sonnet-5-5'], defaultModel: 'claude-sonnet-5-5' }], repositories: [{ name: 'example/docs', enabled: true }] } }));
  await page.route('**/api/instance/extensions/v1**', route => { libraryRequests++; return route.fulfill({ json: { instanceId, library: emptyLibrary } }); });
  await page.route('**/api/task-submission-extensions?**', route => {
    previews.push(new URL(route.request().url()).searchParams.get('repository') ?? '');
    return route.fulfill({ json: { qualified: true, revision: 7, servers: [{ name: 'documentation', capability: 'read' }, { name: 'tracker', capability: 'write' }], skills: [{ name: 'documentation-review' }] } });
  });
  await page.route('**/api/task-submissions', async route => {
    const body = route.request().postData() ?? '';
    submissions.push({ payload: JSON.parse(/name="payload"\r\n\r\n([^\r]*)/.exec(body)![1]), header: route.request().headers()['x-propr-extensions'] });
    return route.fulfill({ status: 400, json: { error: 'Synthetic stop' } });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/tasks/new');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /example.*docs/ }).click();
  await dialog.getByLabel('Prompt', { exact: true }).fill('Check the documentation links.');
  await dialog.locator('summary', { hasText: 'Advanced Options' }).click();
  const applied = dialog.getByTestId('task-extensions-applied');
  await expect(applied).toContainText('MCP servers: documentation');
  await expect(applied).toContainText('Write MCP servers (opt-in): tracker');
  await expect(applied).toContainText('Skills: documentation-review');
  expect(previews).toContain('example/docs');
  await dialog.getByLabel(/Allow write servers/).check();
  await dialog.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ payload: { extensionAllowWrite: true }, header: '1' });
  // The refused request is discarded; the form keeps its choices for another attempt.
  await dialog.getByRole('switch', { name: /Run without extensions/ }).check();
  await expect(dialog.getByLabel(/Allow write servers/)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].payload).toMatchObject({ disableExtensions: true });
  expect(submissions[1].payload).not.toHaveProperty('extensionAllowWrite');
  expect(submissions[1].header).toBeUndefined();
  expect(libraryRequests).toBe(0);
});

test('extension library item limits use selections and keep unlisted values editable', async ({ page }) => {
  await installSettingsFixture(page);
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: {
    agents: [{ alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] }, { alias: 'codex-main', kind: 'direct', type: 'codex', enabled: true, supportedModels: [] }],
    repositories: [{ name: 'example/docs', enabled: true }, { name: 'example/app', enabled: true }],
  } }));
  const bundle = { id: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', instanceId, name: 'Documentation review', digest: 'd'.repeat(64), files: 3, bytes: 8120, requirements: [], source: { kind: 'archive', filename: 'review.tar.gz' }, createdAt: 1791907200000, auditActor: '1' };
  const library = {
    version: 1, instanceId, revision: 1,
    servers: [{ kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search', 'read_document'], capability: 'read', authentication: 'none', repositories: ['example/docs'], agents: ['claude-main', 'retired-agent'], autoApply: true }],
    skills: [] as unknown[], skillBundles: [] as unknown[], secrets: {}, createdAt: 1791907200000, updatedAt: 1791907200000, auditActor: '1',
  };
  let saved: typeof library;
  await page.route('**/api/instance/extensions/v1**', route => {
    if (route.request().url().endsWith('/skills/github-source')) return route.fulfill({ json: { refs: [] } });
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(saved ? saved.revision : 1);
      saved = { ...library, ...body.input, revision: body.expectedRevision + 1, skillBundles: body.input.skills.length ? [bundle] : [] };
      return route.fulfill({ json: { library: saved } });
    }
    return route.fulfill({ json: { instanceId, library, bundles: [bundle], catalog: [] } });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=agent-extensions');
  const section = page.getByRole('region', { name: 'Skills & MCP servers', exact: true });
  const docs = section.getByTestId('extension-server').first();
  // A saved agent limit opens the advanced disclosure.
  await expect(docs.getByLabel('retired-agent', { exact: true })).toBeChecked();
  await docs.getByLabel('retired-agent', { exact: true }).uncheck();
  await docs.getByLabel('codex-main', { exact: true }).check();
  await docs.getByLabel('example/app', { exact: true }).check();
  await docs.getByLabel('read_document', { exact: true }).uncheck();
  await docs.getByRole('checkbox', { name: /Apply automatically/ }).uncheck();
  await section.getByRole('button', { name: 'Save library' }).click();
  await expect(section.getByRole('status')).toHaveText('Extension library saved.');
  expect(saved!.servers[0]).toMatchObject({ agents: ['claude-main', 'codex-main'], repositories: ['example/docs', 'example/app'], tools: ['search'], autoApply: false });
  await section.getByLabel('Add an existing validated skill').selectOption(bundle.id);
  const skill = section.getByTestId('extension-skill');
  await skill.getByLabel('example/docs', { exact: true }).check();
  await skill.getByText('Advanced: limit to agents', { exact: true }).click();
  await skill.getByLabel('claude-main', { exact: true }).check();
  await expect(section.getByText('Documentation review · 3 files · 7.9 KiB')).toBeVisible();
  await expect(section.getByText('7.9 KiB', { exact: true })).toHaveAttribute('title', '8120 bytes');
  await expect(section.getByLabel('Add an existing validated skill')).toBeDisabled();
  await section.getByRole('button', { name: 'Add HTTPS server' }).click();
  const added = section.getByTestId('extension-server').nth(1);
  await added.getByLabel('Use a saved HTTPS endpoint').selectOption('https://tools.example.com/mcp');
  await expect(added.getByLabel('search', { exact: true })).not.toBeChecked();
  await added.getByLabel('search', { exact: true }).check();
  const tools = added.getByRole('group', { name: 'Allowed tools', exact: true });
  await tools.getByText('Advanced: add an unlisted item', { exact: true }).click();
  await tools.getByLabel('Unlisted allowed tools item').fill('read_document');
  await tools.getByRole('button', { name: 'Add item' }).click();
  await expect(added.getByLabel('read_document', { exact: true })).toBeChecked();
  await tools.getByText('Advanced: add an unlisted item', { exact: true }).click();
  await section.getByText('Import from an authorized GitHub repository', { exact: true }).click();
  await section.getByLabel('Repository', { exact: true }).selectOption('example/docs');
  await expect(section.getByLabel('Repository', { exact: true })).toHaveValue('example/docs');
  await section.getByText('Import from an authorized GitHub repository', { exact: true }).click();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await skill.screenshot({ path: path.join(directory, 'extension-scope-selections.png'), animations: 'disabled' });
    await tools.screenshot({ path: path.join(directory, 'extension-tool-selections.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/extension-scope-selections.png', title: 'Limit a library skill', description: 'Each library item has repository limits, Apply automatically and agent limits under Advanced, with manual entry available.' },
      { path: '.propr/previews/extension-tool-selections.png', title: 'Select allowed tools', description: 'Known HTTPS tool names can be selected with checkboxes rather than entered as a comma-separated list.' },
    ], toolSuggestions: [] }));
  }
  await section.getByRole('button', { name: 'Save library' }).click();
  await expect(section.getByRole('status')).toHaveText('Extension library saved.');
  expect(saved!.skills).toEqual([{ bundleId: bundle.id, enabled: true, repositories: ['example/docs'], agents: ['claude-main'], autoApply: true }]);
  expect((saved!.servers[1] as { tools: string[] }).tools).toEqual(['search', 'read_document']);
});


test('extension editor keeps server names and pending tokens attached to rows and offers eligible agents and unused skills', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 1600 });
  await installSettingsFixture(page);
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: {
    agents: [
      { alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] },
      { alias: 'codex-main', kind: 'direct', type: 'codex', enabled: true, supportedModels: [] },
      { alias: 'disabled', kind: 'direct', type: 'claude', enabled: false, supportedModels: [] },
      { alias: 'pool', kind: 'synthetic', type: 'claude', enabled: true, supportedModels: [] },
      { alias: 'opencode', kind: 'direct', type: 'opencode', enabled: true, supportedModels: [] },
      { alias: 'invalid.alias', kind: 'direct', type: 'codex', enabled: true, supportedModels: [] },
    ], repositories: [],
  } }));
  const bundle = { id: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', instanceId, name: 'Previously imported review', digest: 'd'.repeat(64), files: 1, bytes: 120, requirements: [], source: { kind: 'archive', filename: 'review.tar' }, createdAt: 1791907200000, auditActor: '1' };
  const saves: Array<{ input: { servers: Array<{ name: string }>; skills: Array<{ bundleId: string; agents: string[] }> }; expectedRevision: number; secrets: Record<string, string> }> = [];
  await page.route('**/api/instance/extensions/v1**', route => {
    if (route.request().url().endsWith('/skills/archive')) return route.fulfill({ json: { bundle: { ...bundle, id: '175bb20e-4156-4f6c-a7e2-20fd6c8ba84e', name: 'Session import' } } });
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); saves.push(body);
      return route.fulfill({ json: { library: { ...emptyLibrary, ...body.input, revision: saves.length, updatedAt: 1791907200000, skillBundles: [bundle] } } });
    }
    return route.fulfill({ json: { instanceId, library: emptyLibrary, bundles: [bundle], catalog: [{ id: 'docs', digest: 'a'.repeat(64), tools: ['lookup'], capability: 'read', secrets: { count: 0, configured: true } }] } });
  });
  await page.goto('/settings?tab=agent-extensions');
  const section = page.getByRole('region', { name: 'Skills & MCP servers', exact: true });
  await expect(section.getByText('Not saved yet.', { exact: false })).toBeVisible();
  await section.getByLabel('Add an existing validated skill').selectOption(bundle.id);
  await expect(section.getByText('Previously imported review · 1 files · 120 bytes')).toBeVisible();
  const skill = section.getByTestId('extension-skill');
  await skill.getByText('Advanced: limit to agents', { exact: true }).click();
  const agents = skill.getByRole('group', { name: 'Agents', exact: true });
  await expect(agents.getByRole('checkbox')).toHaveCount(2);
  await agents.getByLabel('claude-main', { exact: true }).check();
  await expect(agents.getByLabel('codex-main', { exact: true })).toBeVisible();
  for (let i = 0; i < 3; i++) await section.getByRole('button', { name: 'Add HTTPS server' }).click();
  const names = section.getByLabel('Stable server name', { exact: true });
  await section.getByRole('button', { name: 'Remove server' }).nth(1).click();
  await section.getByRole('button', { name: 'Add HTTPS server' }).click();
  await expect(names.nth(2)).toHaveValue('server-2');
  await section.getByRole('button', { name: 'Remove server' }).nth(2).click();
  await section.getByLabel('Add operator catalog entry').selectOption('docs');
  await expect(names.nth(2)).toHaveValue('server-2');
  await section.getByLabel('HTTPS endpoint', { exact: true }).nth(0).fill('https://tools.example.com/first');
  await section.getByLabel('HTTPS endpoint', { exact: true }).nth(1).fill('https://tools.example.com/second');
  await section.getByRole('combobox', { name: 'Authentication', exact: true }).nth(1).selectOption('bearer');
  await section.getByLabel(/Replace bearer token/).fill('synthetic-test-token');
  // Temporary duplicate names must not move pending tokens between rows.
  await names.nth(1).fill('server-1');
  await names.nth(1).fill('renamed');
  await section.getByRole('button', { name: 'Remove server' }).nth(0).click();
  await expect(section.getByLabel(/Replace bearer token/)).toHaveValue('synthetic-test-token');
  await section.getByRole('button', { name: 'Save library' }).click();
  await expect(section.getByRole('status')).toHaveText('Extension library saved.');
  expect(saves[0].expectedRevision).toBe(0);
  expect(saves[0].secrets).toEqual({ renamed: 'synthetic-test-token' });
  expect(saves[0].input.servers.map(s => s.name)).toEqual(['renamed', 'server-2']);
  expect(saves[0].input.skills.map(s => [s.bundleId, s.agents])).toEqual([[bundle.id, ['claude-main']]]);
  await section.getByLabel(/Replace bearer token/).fill('discarded-token');
  await section.getByRole('combobox', { name: 'Authentication', exact: true }).selectOption('none');
  await section.getByRole('combobox', { name: 'Authentication', exact: true }).selectOption('bearer');
  await expect(section.getByLabel(/Replace bearer token/)).toHaveValue('');
  await section.getByLabel(/Replace bearer token/).fill('endpoint-token');
  await section.getByLabel('HTTPS endpoint', { exact: true }).fill('https://tools.example.com/changed');
  await expect(section.getByLabel(/Replace bearer token/)).toHaveValue('');
  await section.getByRole('button', { name: 'Save library' }).click();
  await expect(section.getByRole('status')).toHaveText('Extension library saved.');
  expect(saves[1].expectedRevision).toBe(1);
  expect(saves[1].secrets).toEqual({});
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.setViewportSize({ width: 1280, height: 1900 });
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await agents.screenshot({ path: path.join(directory, 'extension-eligible-agents.png'), animations: 'disabled' });
    await section.getByText('Previously imported review · 1 files · 120 bytes').locator('..').screenshot({ path: path.join(directory, 'extension-imported-skill.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/extension-eligible-agents.png', title: 'Eligible item agents', description: 'The agent limit offers enabled direct Claude and Codex agents with valid aliases.' },
      { path: '.propr/previews/extension-imported-skill.png', title: 'Previously imported skill', description: 'A validated skill imported earlier without being in the library is added from the instance inventory.' },
    ], toolSuggestions: [] }));
  }
  await section.locator('input[type="file"]').setInputFiles({ name: 'session.tar', mimeType: 'application/x-tar', buffer: Buffer.from('synthetic archive fixture') });
  await expect(section.getByRole('status')).toHaveText('Validated skill bundle added. Save the library to use it.');
  await expect(section.getByText('Session import · 1 files · 120 bytes')).toBeVisible();
  await expect(section.getByTestId('extension-skill').nth(1).getByRole('checkbox', { name: /Apply automatically/ })).toBeChecked();
});

test('new HTTPS tools and GitHub branch imports can be selected with immutable confirmation', async ({ page }) => {
  await installSettingsFixture(page);
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: { agents: [], repositories: [{ name: 'example/docs', enabled: true }, { name: 'example/app', enabled: true }] } }));
  const sha = 'b'.repeat(40);
  let imported: unknown;
  let releaseDiscovery: () => void;
  const held = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  let releaseRef: () => void;
  const heldRef = new Promise<void>(resolve => { releaseRef = resolve; });
  await page.route('**/api/instance/extensions/v1**', async route => {
    const url = route.request().url();
    if (url.endsWith('/tools/discover')) {
      const body = route.request().postDataJSON(); expect(Object.keys(body)).toEqual(['url']);
      if (body.url.endsWith('/slow')) { await held; return route.fulfill({ json: { tools: ['stale_tool'] } }); }
      return route.fulfill({ json: { tools: ['lookup', 'search_docs'] } });
    }
    if (url.endsWith('/skills/github-source')) {
      const body = route.request().postDataJSON();
      if (body.ref === 'refs/tags/v1') await heldRef;
      return route.fulfill({ json: body.ref ? { commit: sha } : { refs: [{ name: 'main', ref: 'refs/heads/main', kind: 'branch' }, { name: 'v1', ref: 'refs/tags/v1', kind: 'tag' }] } });
    }
    if (url.endsWith('/skills/github')) {
      imported = route.request().postDataJSON();
      return route.fulfill({ json: { bundle: { id: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', name: 'Review skill', digest: 'd'.repeat(64), files: 1, bytes: 512, source: { kind: 'github', repository: 'example/docs', commit: sha, directory: 'skills/review' }, requirements: [] } } });
    }
    return route.fulfill({ json: { instanceId, library: emptyLibrary, bundles: [], catalog: [] } });
  });
  await page.setViewportSize({ width: 1280, height: 1500 });
  await page.goto('/settings?tab=agent-extensions');
  const section = page.getByRole('region', { name: 'Skills & MCP servers', exact: true });
  await section.getByRole('button', { name: 'Add HTTPS server' }).click();
  const endpoint = section.getByLabel('HTTPS endpoint', { exact: true });
  await endpoint.fill('https://tools.example.com/slow');
  const probeRequest = page.waitForRequest(r => r.url().endsWith('/tools/discover'));
  await section.getByRole('button', { name: 'Discover tools' }).click(); await probeRequest;
  await endpoint.fill('https://tools.example.com/new');
  await section.getByRole('button', { name: 'Discover tools' }).click();
  await section.getByLabel('lookup', { exact: true }).check();
  const staleReply = page.waitForResponse(r => r.url().endsWith('/tools/discover') && r.request().postDataJSON().url.endsWith('/slow'));
  releaseDiscovery!(); await staleReply;
  await expect(section.getByLabel('stale_tool', { exact: true })).toHaveCount(0);
  await expect(section.getByLabel('search_docs', { exact: true })).toBeVisible();
  await section.getByText('Import from an authorized GitHub repository', { exact: true }).click();
  await section.getByLabel('Repository', { exact: true }).selectOption('example/docs');
  await section.getByRole('combobox', { name: 'Branch or tag', exact: true }).selectOption('refs/heads/main');
  await expect(section.getByText('Confirmed import commit:')).toContainText(sha);
  await section.getByLabel('Relative skill directory', { exact: true }).fill('skills/review');
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await section.getByRole('group', { name: 'Allowed tools', exact: true }).locator('..').screenshot({ path: path.join(directory, 'extension-discovered-tools.png'), animations: 'disabled' });
    await section.getByRole('combobox', { name: 'Branch or tag', exact: true }).locator('..').locator('..').screenshot({ path: path.join(directory, 'extension-github-ref.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/extension-discovered-tools.png', title: 'Discover HTTPS tools', description: 'A first-time HTTPS endpoint provides selectable tool names from a secret-free probe.' },
      { path: '.propr/previews/extension-github-ref.png', title: 'Resolve branch to pinned commit', description: 'Select a GitHub branch or tag, confirm its exact commit and import an immutable skill bundle.' },
    ], toolSuggestions: [] }));
  }
  await section.getByRole('button', { name: 'Import pinned skill' }).click();
  expect(imported).toEqual({ repository: 'example/docs', commit: sha, directory: 'skills/review' });
  const tagRequest = page.waitForRequest(r => r.url().endsWith('/skills/github-source') && r.postDataJSON().ref === 'refs/tags/v1');
  await section.getByRole('combobox', { name: 'Branch or tag', exact: true }).selectOption('refs/tags/v1'); await tagRequest;
  await section.getByLabel('Repository', { exact: true }).selectOption('example/app');
  const staleRefReply = page.waitForResponse(r => r.url().endsWith('/skills/github-source') && r.request().postDataJSON().ref === 'refs/tags/v1');
  releaseRef!(); await staleRefReply;
  await expect(section.getByText('Confirmed import commit:')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Import pinned skill' })).toBeDisabled();
});
