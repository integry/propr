import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installSettingsFixture } from './settings-layout.fixture';

const instanceId = 'c63a25da-fd5e-4a46-8fe1-566136e12289';
const allowAll = { repositories: [] as string[], agents: [] as string[], autoApply: true };
const emptyLibrary = { version: 1, instanceId, revision: 0, servers: [], skills: [], secrets: {}, skillBundles: [], createdAt: 0, updatedAt: 0, auditActor: '' };
const bundleId = '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e';
const reviewBundle = { id: bundleId, instanceId, name: 'documentation-review', digest: 'd853bea9e15d14bc3881f84dd19a2cb940624fda943e677e6b6ac9cc31ff1009', files: 3, bytes: 8120, requirements: ['documentation.search'], source: { kind: 'github', repository: 'example/skills', commit: 'd66d0ad62a789374f81f7e1c4f5dbcc43319e1a6', directory: 'skills/documentation-review' }, createdAt: 1791907200000, auditActor: '1' };
const catalogAgents = {
  agents: [{ alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] }, { alias: 'codex-main', kind: 'direct', type: 'codex', enabled: true, supportedModels: [] }],
  repositories: [{ name: 'example/docs', enabled: true }, { name: 'example/app', enabled: true }],
};
type Library = Omit<typeof emptyLibrary, 'servers' | 'skills' | 'secrets' | 'skillBundles'> & { servers: Record<string, unknown>[]; skills: Record<string, unknown>[]; secrets: Record<string, unknown>; skillBundles: unknown[] };

/**
 * A stateful library API: reads return the last saved revision, saves and the
 * single-item enable switch create the next one, so a reload shows what was saved.
 */
async function libraryApi(page: Page, initial: Library, extra: { bundles?: unknown[]; catalog?: unknown[]; usage?: unknown } = {}) {
  const state = { library: initial, saves: [] as Record<string, unknown>[], toggles: [] as Record<string, unknown>[] };
  await page.route('**/api/instance/extensions/v1**', route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { revisions: [state.library] } });
    if (url.pathname.endsWith('/validate')) return route.fulfill({ json: { results: [{ name: 'documentation', reachable: true, status: 'reachable' }] } });
    if (request.method() === 'POST') {
      expect(request.headers()['x-propr-extensions']).toBe('1');
      const body = request.postDataJSON();
      if (url.pathname.endsWith('/items/enabled')) {
        state.toggles.push(body);
        const flip = (item: Record<string, unknown>) => ((body.item.kind === 'server' ? item.name === body.item.name : item.bundleId === body.item.bundleId) ? { ...item, enabled: body.enabled } : item);
        state.library = { ...state.library, revision: state.library.revision + 1, servers: state.library.servers.map(flip), skills: state.library.skills.map(flip) };
        return route.fulfill({ json: { library: state.library } });
      }
      if (url.pathname.endsWith('/library')) {
        state.saves.push(body);
        expect(body.expectedRevision).toBe(state.library.revision);
        const secrets = { ...state.library.secrets };
        for (const name of Object.keys(body.secrets)) secrets[name] = { fields: ['bearerToken'], configured: true };
        const skillBundles = body.input.skills.map((skill: { bundleId: string }) => [reviewBundle, ...(extra.bundles ?? [])].find(b => (b as { id: string }).id === skill.bundleId));
        state.library = { ...state.library, ...body.input, secrets, skillBundles, revision: state.library.revision + 1, updatedAt: 1791907200000, auditActor: '1' };
        return route.fulfill({ json: { library: state.library } });
      }
      return route.fallback();
    }
    return route.fulfill({ json: { instanceId, library: state.library, bundles: extra.bundles ?? [], catalog: extra.catalog ?? [], usage: extra.usage } });
  });
  return state;
}
const sectionOf = (page: Page) => page.getByRole('region', { name: 'Skills & MCP servers', exact: true });

test('the library lists servers and skills as rows with provenance, write-only authentication, validation and history', async ({ page }) => {
  await installSettingsFixture(page);
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: catalogAgents }));
  const library = {
    ...emptyLibrary, revision: 3, createdAt: 1791907200000, updatedAt: 1791907200000, auditActor: '1',
    servers: [{ kind: 'https', name: 'documentation', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search', 'read_document'], capability: 'read', authentication: 'bearer', repositories: ['example/docs'], agents: ['claude-main'], autoApply: true }],
    skills: [{ bundleId, enabled: true, ...allowAll, autoApply: false }],
    secrets: { documentation: { fields: ['bearerToken'], configured: true } },
    skillBundles: [reviewBundle],
  };
  const api = await libraryApi(page, library, {
    catalog: [{ id: 'operator-documentation', digest: 'a'.repeat(64), tools: ['lookup', 'update_document'], capability: 'write', secrets: { count: 1, configured: true } }],
    usage: { automations: [{ id: 'a1', name: 'Weekly docs audit', servers: ['documentation'], skills: [] }], importedFrom: { servers: {}, skills: { [bundleId]: ['Docs profile'] } } },
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=agent-extensions');
  const section = sectionOf(page);
  await expect(section.getByText(/Give agents extra tools for a task/)).toContainText('Only Claude and Codex runs can use extensions.');
  await expect(section.getByRole('list', { name: 'How extensions apply' })).toContainText('disable-extensions');
  await expect(section.getByText(/Revision 3 · updated/)).toBeVisible();
  const server = section.getByTestId('extension-server');
  await expect(server).toContainText('documentation');
  await expect(server).toContainText('example/docs · Applies automatically · Agents: claude-main');
  await expect(server).toContainText('Added by automation “Weekly docs audit”.');
  const skill = section.getByTestId('extension-skill');
  await expect(skill).toContainText('Imported from profile “Docs profile”; not applied automatically.');
  await expect(skill).toContainText('Applies to Codex');
  await server.getByRole('button', { name: 'Edit' }).click();
  const form = section.getByTestId('extension-server-form');
  await expect(form.getByLabel(/^Bearer token/)).toHaveValue('');
  await expect(form.getByText('(configured; write-only)', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await skill.getByRole('button', { name: 'Edit' }).click();
  await expect(section.getByTestId('extension-skill-form').getByText(/SHA-256 d853bea/)).toBeVisible();
  await section.getByTestId('extension-skill-form').getByRole('button', { name: 'Cancel' }).click();
  await section.getByRole('button', { name: 'Validate saved MCP connectivity' }).click();
  await expect(section.getByRole('status')).toHaveText('documentation: reachable');
  await section.getByRole('button', { name: 'Revision history' }).click();
  await expect(section.getByText(/Revision 3.*administrator 1/)).toBeVisible();
  // An operator catalog server is added in one form.
  await section.getByRole('button', { name: 'Add server' }).click();
  const add = section.getByTestId('extension-server-form');
  await add.getByLabel('Server type').selectOption('operator-documentation');
  await expect(add.locator('p', { hasText: 'Operator catalog entry: operator-documentation' })).toBeVisible();
  await expect(add.getByText('Operator secrets: configured', { exact: true })).toBeVisible();
  await expect(add.getByRole('checkbox', { name: /Apply automatically/ })).toBeChecked();
  await expect(add.getByLabel('lookup', { exact: true })).toBeChecked();
  await expect(add.getByLabel(/^Capability/)).toHaveValue('write');
  await expect(add.getByLabel(/^Capability/)).toBeDisabled();
  await add.getByLabel('update_document', { exact: true }).uncheck();
  await add.getByRole('button', { name: 'Add server' }).click();
  await expect(section.getByRole('status')).toHaveText('Server server-1 added.');
  expect(api.saves[0].input).toMatchObject({ servers: [library.servers[0], { kind: 'catalog', name: 'server-1', catalogId: 'operator-documentation', digest: 'a'.repeat(64), enabled: true, tools: ['lookup'], capability: 'write', ...allowAll }] });
  await expect(section.getByText(/Revision 4 · updated/)).toBeVisible();
  await expect(section.getByTestId('extension-server').nth(1)).toContainText('Write');
  expect(await section.textContent()).not.toMatch(/API_KEY|OPERATOR_DOCS_KEY|UNMISTAKABLE|CATALOG_ARGUMENT_SENTINEL|CATALOG_PATH_SENTINEL|\/usr\/bin\/env/);
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

test('a server and a skill are added in one flow each, switched off and on with one click, and survive a reload', async ({ page }) => {
  test.setTimeout(60_000);
  await installSettingsFixture(page);
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: catalogAgents }));
  const api = await libraryApi(page, { ...emptyLibrary, servers: [], skills: [], skillBundles: [] }, { bundles: [reviewBundle] });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto('/settings?tab=agent-extensions');
  const section = sectionOf(page);
  await expect(section.getByText('Nothing saved yet.', { exact: false })).toBeVisible();
  await section.getByRole('button', { name: 'Add server' }).click();
  const form = section.getByTestId('extension-server-form');
  await form.getByLabel(/^Server name/).fill('tracker');
  await form.getByLabel('HTTPS endpoint', { exact: true }).fill('https://tracker.example.com/mcp');
  const tools = form.getByRole('group', { name: 'Allowed tools', exact: true });
  await tools.getByText('Add an unlisted value', { exact: true }).click();
  await tools.getByLabel('Unlisted tool name').fill('create_issue');
  await tools.getByRole('button', { name: 'Add' }).click();
  await form.getByLabel(/^Capability/).selectOption('write');
  await form.getByLabel('Authentication').selectOption('bearer');
  await form.getByLabel(/^Bearer token/).fill('synthetic-test-token');
  await form.getByRole('group', { name: 'Limit to repositories' }).getByLabel('example/docs', { exact: true }).check();
  await form.getByText('Advanced', { exact: true }).click();
  await form.getByRole('group', { name: 'Limit to agents' }).getByLabel('claude-main', { exact: true }).check();
  await form.getByRole('button', { name: 'Add server' }).click();
  await expect(section.getByRole('status')).toHaveText('Server tracker added.');
  expect(api.saves[0]).toEqual({ expectedRevision: 0, secrets: { tracker: 'synthetic-test-token' }, input: { version: 1, skills: [], servers: [{
    kind: 'https', name: 'tracker', url: 'https://tracker.example.com/mcp', enabled: true, tools: ['create_issue'], capability: 'write', authentication: 'bearer',
    repositories: ['example/docs'], agents: ['claude-main'], autoApply: true,
  }] } });

  await section.getByRole('button', { name: 'Add skill' }).click();
  const skillForm = section.getByTestId('extension-skill-form');
  await skillForm.getByLabel('Use an imported skill').selectOption(bundleId);
  await expect(skillForm.getByText('3 files · 7.9 KiB')).toBeVisible();
  await skillForm.getByRole('checkbox', { name: /Apply automatically/ }).uncheck();
  await skillForm.getByRole('group', { name: 'Limit to repositories' }).getByLabel('example/app', { exact: true }).check();
  await skillForm.getByRole('button', { name: 'Add skill' }).click();
  await expect(section.getByRole('status')).toHaveText('Skill documentation-review added.');
  expect(api.saves[1].input).toMatchObject({ skills: [{ bundleId, enabled: true, repositories: ['example/app'], agents: [], autoApply: false }] });

  // One click switches an item off through the single-item endpoint; no form, no save step.
  const server = section.getByTestId('extension-server');
  await server.getByRole('checkbox', { name: 'Enabled: tracker' }).uncheck();
  await expect(server).toHaveAttribute('data-enabled', 'false');
  await expect(server).toContainText('Off');
  expect(api.toggles).toEqual([{ item: { kind: 'server', name: 'tracker' }, enabled: false }]);
  expect(api.saves).toHaveLength(2);
  const skill = section.getByTestId('extension-skill');
  await skill.getByRole('checkbox', { name: 'Enabled: documentation-review' }).uncheck();
  await expect(skill).toHaveAttribute('data-enabled', 'false');

  await page.reload();
  await expect(section.getByText(/Revision 4 · updated/)).toBeVisible();
  await expect(section.getByRole('checkbox', { name: 'Enabled: tracker' })).not.toBeChecked();
  await expect(section.getByTestId('extension-server')).toContainText('example/docs · Applies automatically · Agents: claude-main');
  await expect(section.getByTestId('extension-skill')).toContainText('example/app · Only where an automation adds it');
  await section.getByRole('checkbox', { name: 'Enabled: tracker' }).check();
  await expect(section.getByRole('checkbox', { name: 'Enabled: tracker' })).toBeChecked();
  await page.reload();
  await expect(section.getByRole('checkbox', { name: 'Enabled: tracker' })).toBeChecked();
  // Settings, limits and the secret presence marker are unchanged after the round trip.
  await section.getByTestId('extension-server').getByRole('button', { name: 'Edit' }).click();
  const edit = section.getByTestId('extension-server-form');
  await expect(edit.getByText('(configured; write-only)', { exact: true })).toBeVisible();
  await expect(edit.getByLabel(/^Bearer token/)).toHaveValue('');
  await expect(edit.getByRole('group', { name: 'Limit to repositories' }).getByLabel('example/docs', { exact: true })).toBeChecked();
  await expect(edit.getByRole('group', { name: 'Limit to agents' }).getByLabel('claude-main', { exact: true })).toBeChecked();
  await expect(edit.getByLabel('create_issue', { exact: true })).toBeChecked();
  await edit.getByRole('button', { name: 'Cancel' }).click();
  expect(await section.textContent()).not.toContain('synthetic-test-token');

  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await section.getByTestId('extension-skill').getByRole('checkbox').check();
    await expect(section.getByTestId('extension-skill')).toHaveAttribute('data-enabled', 'true');
    await section.getByRole('checkbox', { name: 'Enabled: tracker' }).uncheck();
    await expect(section.getByTestId('extension-server')).toHaveAttribute('data-enabled', 'false');
    await page.setViewportSize({ width: 1280, height: 1300 });
    await section.screenshot({ path: path.join(directory, 'extension-library-lists.png'), animations: 'disabled' });
    await section.getByRole('button', { name: 'Add server' }).click();
    await section.getByTestId('extension-server-form').getByText('Advanced', { exact: true }).click();
    await section.getByTestId('extension-server-form').screenshot({ path: path.join(directory, 'extension-server-form.png'), animations: 'disabled' });
    await section.getByTestId('extension-server-form').getByRole('button', { name: 'Cancel' }).click();
    await page.setViewportSize({ width: 390, height: 1400 });
    await section.getByRole('heading', { name: 'MCP servers', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, 'extension-library-phone.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/extension-library-lists.png', title: 'Skills & MCP servers lists', description: 'Flat MCP server and skill lists with enabled checkboxes; a switched-off server stays dimmed with an Off status.' },
      { path: '.propr/previews/extension-server-form.png', title: 'Add server form', description: 'One form for an HTTPS or catalog server with tools, capability, write-only token, repository limit, Apply automatically and the agent limit under Advanced.' },
      { path: '.propr/previews/extension-library-phone.png', title: 'Phone width', description: 'The lists at 390 px width.' },
    ], toolSuggestions: [] }));
  }
});

test('the agent limit offers eligible agents and a rename or endpoint change never moves a stored token', async ({ page }) => {
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
  const docs = { kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read', authentication: 'bearer', ...allowAll };
  const api = await libraryApi(page, { ...emptyLibrary, revision: 1, servers: [docs], skills: [], secrets: { docs: { fields: ['bearerToken'], configured: true } }, skillBundles: [] });
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto('/settings?tab=agent-extensions');
  const section = sectionOf(page);
  await section.getByTestId('extension-server').getByRole('button', { name: 'Edit' }).click();
  const form = section.getByTestId('extension-server-form');
  await form.getByText('Advanced', { exact: true }).click();
  const agents = form.getByRole('group', { name: 'Limit to agents', exact: true });
  await expect(agents.getByRole('checkbox')).toHaveCount(2);
  await expect(agents.getByLabel('codex-main', { exact: true })).toBeVisible();
  await agents.getByLabel('claude-main', { exact: true }).check();
  const token = form.getByLabel(/^Bearer token/);
  // A replacement token typed for one endpoint never follows the server to another one.
  await token.fill('token-for-original');
  await form.getByLabel('HTTPS endpoint', { exact: true }).fill('https://tools.example.com/changed');
  await expect(token).toHaveValue('');
  await expect(form.getByText('Changing the name or endpoint clears the stored token. Enter it again.')).toBeVisible();
  await token.fill('token-for-changed');
  await form.getByLabel('Use a saved HTTPS endpoint').selectOption('https://tools.example.com/mcp');
  await expect(form.getByLabel('HTTPS endpoint', { exact: true })).toHaveValue('https://tools.example.com/mcp');
  await expect(token).toHaveValue('');
  await expect(form.getByText(/clears the stored token/)).toHaveCount(0);
  // Switching authentication off drops the pending token too.
  await token.fill('pending-token');
  await form.getByLabel('Authentication').selectOption('none');
  await form.getByLabel('Authentication').selectOption('bearer');
  await expect(token).toHaveValue('');
  await form.getByRole('button', { name: 'Save server' }).click();
  await expect(section.getByRole('status')).toHaveText('Server docs saved.');
  expect(api.saves[0]).toEqual({ expectedRevision: 1, secrets: {}, input: { version: 1, skills: [], servers: [{ ...docs, agents: ['claude-main'] }] } });
  // A removal needs confirmation.
  await section.getByTestId('extension-server').getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByText(/Remove docs from the library\?/)).toBeVisible();
  await section.getByRole('button', { name: 'Keep' }).click();
  expect(api.saves).toHaveLength(1);
});

test('a refused removal names the automations that add the item', async ({ page }) => {
  await installSettingsFixture(page);
  const docs = { kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read', authentication: 'none', ...allowAll };
  await page.route('**/api/instance/extensions/v1**', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 409, json: { error: 'Automations add these extensions explicitly; remove them from "Weekly docs audit" (docs) before removing or renaming them' } });
    return route.fulfill({ json: { instanceId, library: { ...emptyLibrary, revision: 2, servers: [docs] }, bundles: [], catalog: [] } });
  });
  await page.goto('/settings?tab=agent-extensions');
  const section = sectionOf(page);
  await section.getByTestId('extension-server').getByRole('button', { name: 'Remove' }).click();
  await section.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(section.getByRole('alert')).toContainText('"Weekly docs audit" (docs)');
  await expect(section.getByTestId('extension-server')).toBeVisible();
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
      return route.fulfill({ json: { bundle: { id: bundleId, name: 'Review skill', digest: 'd'.repeat(64), files: 1, bytes: 512, source: { kind: 'github', repository: 'example/docs', commit: sha, directory: 'skills/review' }, requirements: [] } } });
    }
    return route.fulfill({ json: { instanceId, library: emptyLibrary, bundles: [], catalog: [] } });
  });
  await page.setViewportSize({ width: 1280, height: 1500 });
  await page.goto('/settings?tab=agent-extensions');
  const section = sectionOf(page);
  await section.getByRole('button', { name: 'Add server' }).click();
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
  await section.getByTestId('extension-server-form').getByRole('button', { name: 'Cancel' }).click();
  await section.getByRole('button', { name: 'Add skill' }).click();
  await section.getByText('Import from an authorized GitHub repository', { exact: true }).click();
  await section.getByLabel('Repository', { exact: true }).selectOption('example/docs');
  await section.getByRole('combobox', { name: 'Branch or tag', exact: true }).selectOption('refs/heads/main');
  await expect(section.getByText('Confirmed import commit:')).toContainText(sha);
  await section.getByLabel('Relative skill directory', { exact: true }).fill('skills/review');
  await section.getByRole('button', { name: 'Import pinned skill' }).click();
  expect(imported).toEqual({ repository: 'example/docs', commit: sha, directory: 'skills/review' });
  const skillForm = section.getByTestId('extension-skill-form');
  await expect(skillForm.getByText('Review skill', { exact: true })).toBeVisible();
  await skillForm.getByRole('button', { name: 'Choose another bundle' }).click();
  await section.getByText('Import from an authorized GitHub repository', { exact: true }).click();
  await section.getByLabel('Repository', { exact: true }).selectOption('example/docs');
  const tagRequest = page.waitForRequest(r => r.url().endsWith('/skills/github-source') && r.postDataJSON().ref === 'refs/tags/v1');
  await section.getByRole('combobox', { name: 'Branch or tag', exact: true }).selectOption('refs/tags/v1'); await tagRequest;
  await section.getByLabel('Repository', { exact: true }).selectOption('example/app');
  const staleRefReply = page.waitForResponse(r => r.url().endsWith('/skills/github-source') && r.request().postDataJSON().ref === 'refs/tags/v1');
  releaseRef!(); await staleRefReply;
  await expect(section.getByText('Confirmed import commit:')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Import pinned skill' })).toBeDisabled();
});
