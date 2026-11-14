import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The Plugins page end to end against a stateful plugin API fixture: the
 * example plugin is installed, connected, configured through the generated
 * settings form, limited to a repository and enabled; its managed items are
 * then shown in Skills & MCP servers; it is disabled and uninstalled entirely
 * from the page. An upgrade asking for more is approved from the detail page.
 * With PROPR_CAPTURE_PREVIEWS set it also captures the catalog and the detail
 * steps at desktop and phone widths.
 */

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const BASE = '/api/instance/plugins/v1';
const REFUSAL = 'Automations add items of plugin example-pack explicitly; remove them from "Weekly digest" (example-remote) before uninstalling';

const MANIFEST = {
  id: 'example-pack', name: 'Example pack', version: '0.1.0', category: 'other',
  description: 'A small development plugin that exercises every manifest section: one remote MCP server, one pinned package server, one skill and one automation template.',
  homepage: 'https://github.com/integry/propr/tree/main/packages/plugins/example-pack',
  permissions: [
    { name: 'events.read', description: 'Receive ProPR task, pull request and automation events' },
    { name: 'tasks.read', description: 'Read tasks and their status' },
  ],
  connections: [
    { type: 'oauth', name: 'example-account', label: 'Example account', help: 'Sign in with the example service account that the remote MCP server should act as.', helpUrl: 'https://example.com/docs/oauth' },
    { type: 'token', name: 'example-token', label: 'Example API token', help: 'Create a read-only API token in the example service settings and paste it here.', helpUrl: 'https://example.com/docs/tokens' },
  ],
  settings: {
    type: 'object',
    properties: {
      greeting: { type: 'string', label: 'Greeting', help: 'Text the local example server prefixes to every echo.', default: 'hello' },
      verbosity: { type: 'string', label: 'Verbosity', enum: ['quiet', 'normal', 'detailed'], default: 'normal' },
      maxItems: { type: 'number', label: 'Maximum items', minimum: 1, maximum: 50, integer: true, default: 10 },
      includeDrafts: { type: 'boolean', label: 'Include draft pull requests', default: false },
      labels: { type: 'array', items: { type: 'string' }, label: 'Labels to watch', default: [] },
      channels: { type: 'object', format: 'repository-map', additionalProperties: { type: 'string' }, label: 'Channel per repository', help: 'Maps owner/repo to a channel name.' },
    },
    required: ['verbosity'],
  },
  outboundHosts: ['api.example.com'],
  contributes: {
    mcpServers: [
      { kind: 'https', name: 'example-remote', url: 'https://mcp.example.com/mcp', tools: ['search', 'fetch'], capability: 'read', authentication: 'oauth', connection: 'example-account' },
      { kind: 'package', name: 'example-local', ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', tools: ['echo'], capability: 'read', secretEnv: [{ name: 'FIXTURE_TOKEN', connection: 'example-token' }] },
    ],
    skills: ['example-notes'], automationTemplates: ['example-weekly-digest'], commands: [], subscriptions: [], webhooks: [],
  },
};
const OTHERS = [
  { id: 'team-chat', name: 'Team chat', category: 'messaging', description: 'Posts task and pull request updates to a chat channel.' },
  { id: 'deploy-hooks', name: 'Deploy hooks', category: 'deployment', description: 'Adds the /deploy command and reports deployment status.' },
];

const DEFAULTS = { greeting: 'hello', verbosity: 'normal', maxItems: 10, includeDrafts: false, labels: [] };
/** The upgrade awaiting approval: version 0.2.0 asks for one more permission and moves the package server to a new version with one more secret variable. */
const UPGRADE = { version: '0.2.0', permission: { name: 'pull_requests.read', description: 'Read pull requests and their status' }, package: 'propr-fixture-mcp', packageVersion: '1.1.0', secretEnv: ['FIXTURE_TOKEN', 'FIXTURE_REGION'] };

interface State {
  installed: boolean; enabled: boolean; token: boolean; oauth: boolean; repositories: string[] | null; refuseUninstall: boolean;
  settings?: Record<string, unknown>; upgrade?: boolean;
}

const blockers = (state: State) => [
  ...(state.settings?.verbosity === undefined ? ['Required setting Verbosity (verbosity) is missing'] : []),
  ...(state.token ? [] : ['Connection Example API token (example-token) is not set']),
];

function view(state: State) {
  const active = state.enabled;
  const library = '/api/instance/extensions/v1';
  return {
    id: 'example-pack', available: true, manifest: state.upgrade ? upgradedManifest() : MANIFEST,
    state: !state.installed ? 'available' : state.enabled ? 'enabled' : 'installed',
    installation: state.installed ? {
      installedVersion: '0.1.0', enabled: state.enabled, settings: state.settings ?? {}, repositories: state.repositories, grantedPermissions: ['events.read', 'tasks.read'],
      acknowledgements: { 'example-local': { actor: '1042', at: NOW, package: 'propr-fixture-mcp', version: '1.0.0', secretEnv: ['FIXTURE_TOKEN'] } },
      installedBy: '1042', installedAt: NOW, updatedBy: '1042', updatedAt: NOW,
    } : null,
    connections: [
      { name: 'example-account', type: 'oauth', label: 'Example account', state: state.oauth ? 'connected' : 'not_connected', required: false },
      { name: 'example-token', type: 'token', label: 'Example API token', state: state.token ? 'connected' : 'not_connected', required: true, ...(state.token ? { setBy: '1042', setAt: NOW } : {}) },
    ],
    needsApproval: Boolean(state.upgrade), pendingPermissions: state.upgrade ? [UPGRADE.permission.name] : [],
    pendingAcknowledgements: state.upgrade ? [{ server: 'example-local', package: UPGRADE.package, version: UPGRADE.packageVersion, secretEnv: UPGRADE.secretEnv }] : [],
    enableBlockers: state.installed ? blockers(state) : [],
    contributions: {
      mcpServers: [
        { name: 'example-remote', kind: 'https', managed: state.installed ? { kind: 'server', name: 'example-remote', enabled: true, active } : null, href: library },
        { name: 'example-local', kind: 'package', managed: state.installed ? { kind: 'server', name: 'example-local', enabled: true, active } : null, href: library },
      ],
      skills: [{ name: 'example-notes', managed: state.installed ? { kind: 'skill', bundleId: 'bundle-1', enabled: true, active } : null, href: library }],
      automationTemplates: [{ id: 'example-weekly-digest', catalogId: 'example-weekly-digest', available: state.enabled, href: '/api/automation-definitions/templates' }],
    },
  };
}
function upgradedManifest() {
  const servers = MANIFEST.contributes.mcpServers.map(server => (server.kind === 'package'
    ? { ...server, version: UPGRADE.packageVersion, secretEnv: UPGRADE.secretEnv.map(name => ({ name, connection: 'example-token' })) } : server));
  return { ...MANIFEST, version: UPGRADE.version, permissions: [...MANIFEST.permissions, UPGRADE.permission], contributes: { ...MANIFEST.contributes, mcpServers: servers } };
}

/** The extension library as Skills & MCP servers reads it: the plugin's managed items once it is installed, next to one own server. */
function extensionLibrary(state: State) {
  const managedBy = (item: string) => ({ plugin: 'example-pack', item, active: state.enabled });
  const limits = { repositories: state.repositories ?? [], agents: [], autoApply: true };
  const bundleId = '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e';
  const own = { kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search'], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: true };
  const servers = state.installed ? [
    { kind: 'https', name: 'example-remote', url: 'https://mcp.example.com/mcp', enabled: true, tools: ['search', 'fetch'], capability: 'read', authentication: 'oauth', ...limits, managedBy: { ...managedBy('example-remote'), registrations: ['dynamic'] } },
    {
      kind: 'package', name: 'example-local', ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', integrity: `sha512-${'Q'.repeat(86)}==`, bin: 'propr-fixture-mcp',
      args: [], env: [{ name: 'FIXTURE_GREETING', value: 'hello' }], secretEnv: ['FIXTURE_TOKEN'], enabled: true, tools: ['echo', 'secret_length'], capability: 'read', ...limits, managedBy: managedBy('example-local'),
    },
    own,
  ] : [own];
  const bundle = { id: bundleId, instanceId: 'instance', name: 'example-notes', digest: 'd'.repeat(64), files: 1, bytes: 512, source: { kind: 'plugin', plugin: 'example-pack', version: '0.1.0', path: 'skills/example-notes' }, requirements: [], createdAt: NOW, auditActor: '1042' };
  return {
    instanceId: 'instance', bundles: [], catalog: [],
    library: {
      instanceId: 'instance', revision: 7, version: 1, createdAt: NOW, updatedAt: NOW, auditActor: '1042', servers,
      skills: state.installed ? [{ bundleId, enabled: true, ...limits, managedBy: managedBy('example-notes') }] : [], skillBundles: state.installed ? [bundle] : [], secrets: {},
    },
    oauth: { redirectUri: 'https://propr.example.com/api/instance/extensions/v1/oauth/callback', clientMetadataUrl: null, connections: {} },
  };
}

/** The settings route of the fixture: the same checks as the API for the one rule the page is driven into, and null removes a setting. */
function saveSettings(state: State, settings: Record<string, unknown>) {
  if (typeof settings.maxItems === 'number' && (settings.maxItems < 1 || settings.maxItems > 50)) return { status: 400, error: `maxItems must be ${settings.maxItems < 1 ? 'at least 1' : 'at most 50'}` };
  if (state.enabled && settings.verbosity === null) return { status: 409, error: 'Required settings cannot be removed while the plugin is enabled: verbosity' };
  state.settings = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== null));
  return null;
}

const ACKNOWLEDGE = 'Confirm that the secret variables of example-local are readable';
const acknowledges = (body: Record<string, unknown>) => (body.acknowledgements as string[] | undefined)?.includes('example-local');
/** The example plugin's mutation routes: null when the path is not one, a refusal, or `{}` once the state changed. */
function pluginMutation(state: State, route: string, body: Record<string, unknown>): { status?: number; error?: string } | null {
  switch (route) {
    case '/install':
      if (!acknowledges(body)) return { status: 400, error: ACKNOWLEDGE };
      Object.assign(state, { installed: true, settings: { ...DEFAULTS } }); return {};
    case '/settings': return saveSettings(state, body.settings as Record<string, unknown>) ?? {};
    case '/approve':
      if (!acknowledges(body)) return { status: 400, error: ACKNOWLEDGE };
      state.upgrade = false; return {};
    case '/connections/example-token': state.token = body.value !== null; return {};
    case '/repositories': state.repositories = body.repositories as string[] | null; return {};
    case '/enabled': state.enabled = body.enabled === true; return {};
    case '/uninstall':
      if (state.refuseUninstall) { state.refuseUninstall = false; return { status: 409, error: REFUSAL }; }
      Object.assign(state, { installed: false, enabled: false, token: false, oauth: false, repositories: null, settings: undefined }); return {};
    default: return null;
  }
}

const otherView = (other: typeof OTHERS[number], enabled: boolean) => ({
  ...view({ installed: enabled, enabled, token: true, oauth: true, repositories: null, refuseUninstall: false }),
  id: other.id, manifest: { ...MANIFEST, ...other, connections: [], contributes: { ...MANIFEST.contributes, mcpServers: [] } }, connections: [],
});

async function installFixture(page: Page, state: State): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (method !== 'GET' && request.headers()['x-propr-plugins'] !== '1') return route.fulfill({ status: 403, json: { error: 'Plugin changes require the preflight-protected JSON contract' } });
    const body = method === 'GET' ? {} : request.postDataJSON() as Record<string, unknown>;
    const reply = () => route.fulfill({ json: { plugin: view(state) } });
    if (pathname === BASE) return route.fulfill({ json: { plugins: [view(state), otherView(OTHERS[0], true), otherView(OTHERS[1], false)] } });
    if (pathname === `${BASE}/example-pack`) return route.fulfill({ json: { plugin: { ...view(state), audit: [] } } });
    const mutated = pluginMutation(state, pathname.slice(`${BASE}/example-pack`.length), body);
    if (mutated) return mutated.error ? route.fulfill({ status: mutated.status, json: { error: mutated.error } }) : reply();
    if (pathname === '/api/instance/extensions/v1') return route.fulfill({ json: extensionLibrary(state) });
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: '1042', login: 'preview', username: 'preview', displayName: 'Preview Operator', email: null, avatarUrl: null, role: 'admin',
        permissions: ['instance.manage_settings', 'instance.manage_members', 'instance.manage_agents'], authorizationSource: 'local',
      },
      '/api/instance/catalog': { agents: [], repositories: [{ name: 'integry/propr' }, { name: 'integry/propr-docs' }] },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in the plugins fixture' } });
  });
}

/** The app scrolls inside its own container, so a capture scrolls the part it shows into view first. */
async function capture(page: Page, name: string, focus?: ReturnType<Page['locator']>): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  if (focus) await focus.evaluate(element => element.scrollIntoView({ block: 'start' }));
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

const step = (page: Page, title: string) => page.getByRole('region', { name: new RegExp(`^\\d\\. ${title}`) });
const badge = (page: Page) => page.getByRole('heading', { level: 1 }).getByTestId('plugin-state');

test('installs, connects, configures, enables, shows the managed items, disables and uninstalls the example plugin', async ({ page }) => {
  const state: State = { installed: false, enabled: false, token: false, oauth: false, repositories: null, refuseUninstall: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page, state);
  await page.goto('/plugins');

  await expect(page.getByRole('navigation').getByRole('link', { name: 'Plugins' })).toHaveAttribute('href', '/plugins');
  await expect(page.getByTestId('plugin-card')).toHaveCount(3);
  await capture(page, 'plugins-catalog-desktop');
  await page.getByLabel('Category').selectOption('messaging');
  await expect(page.getByTestId('plugin-card')).toHaveCount(1);
  await page.getByLabel('Category').selectOption('');
  await page.getByRole('link', { name: 'Example pack: open' }).click();

  const install = step(page, 'Install');
  await expect(install.getByRole('button', { name: 'Install' })).toBeDisabled();
  await expect(install.getByTestId('plugin-secret-acknowledgement')).toContainText('FIXTURE_TOKEN');
  await capture(page, 'plugins-install-step-desktop', install.getByText('Permissions it asks for'));
  await install.getByRole('checkbox', { name: /propr-fixture-mcp@1\.0\.0/ }).check();
  await install.getByRole('button', { name: 'Install' }).click();
  await expect(badge(page)).toHaveText('Needs connection');

  const enable = step(page, 'Enable');
  await expect(enable.getByRole('checkbox', { name: /Enabled/ })).toBeDisabled();
  await expect(enable.getByRole('status')).toContainText('Connection Example API token (example-token) is not set');
  await capture(page, 'plugins-connect-and-enable-blocked-desktop', step(page, 'Connect'));

  const token = step(page, 'Connect').getByTestId('plugin-connection').nth(1);
  await token.getByLabel('Example API token').fill('tok_preview_value');
  await token.getByRole('button', { name: 'Save' }).click();
  await expect(token).toContainText('Stored by administrator 1042');
  await expect(token.getByLabel('Replace Example API token')).toHaveValue('');

  // Configure: the form is generated from the manifest's settings schema and starts from the installed defaults.
  const configure = step(page, 'Configure');
  const settings = configure.getByRole('form', { name: 'Plugin settings' });
  await expect(settings.getByLabel('Greeting')).toHaveValue('hello');
  await expect(settings.getByLabel('Verbosity')).toHaveValue('normal');
  await expect(settings.getByLabel('Maximum items')).toHaveValue('10');
  await expect(settings.getByRole('checkbox', { name: 'Include draft pull requests' })).not.toBeChecked();

  // A required setting left empty blocks Enable, with the reason.
  await settings.getByLabel('Verbosity').selectOption('');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
  await expect(enable.getByRole('checkbox', { name: /Enabled/ })).toBeDisabled();
  await expect(enable.getByRole('status')).toContainText('Required setting Verbosity (verbosity) is missing');
  await expect(configure.getByRole('status').first()).toHaveText('Set Verbosity to enable the plugin.');

  // Invalid input shows the error next to its field.
  const settingsForm = () => step(page, 'Configure').getByRole('form', { name: 'Plugin settings' });
  await settingsForm().getByLabel('Maximum items').fill('99');
  await settingsForm().getByRole('button', { name: 'Save settings' }).click();
  await expect(settingsForm().locator('[data-setting="maxItems"]').getByTestId('plugin-setting-error')).toHaveText('maxItems must be at most 50');
  await capture(page, 'plugins-settings-field-error-desktop', settingsForm());

  await settingsForm().getByLabel('Maximum items').fill('20');
  await settingsForm().getByLabel('Verbosity').selectOption('detailed');
  await settingsForm().getByRole('checkbox', { name: 'Include draft pull requests' }).check();
  await settingsForm().getByLabel('Labels to watch').fill('bug\nrelease');
  await settingsForm().getByRole('button', { name: 'Add repository to Channel per repository' }).click();
  await settingsForm().getByLabel('Channel per repository: repository 1').fill('integry/propr');
  await settingsForm().getByLabel('Channel per repository: value for repository 1').fill('#propr');
  await settingsForm().getByRole('button', { name: 'Save settings' }).click();
  await expect(enable.getByRole('checkbox', { name: /Enabled/ })).toBeEnabled();
  expect(state.settings).toEqual({ greeting: 'hello', verbosity: 'detailed', maxItems: 20, includeDrafts: true, labels: ['bug', 'release'], channels: { 'integry/propr': '#propr' } });

  // The saved values round-trip through a fresh read.
  await page.reload();
  await expect(settingsForm().getByLabel('Verbosity')).toHaveValue('detailed');
  await expect(settingsForm().getByLabel('Maximum items')).toHaveValue('20');
  await expect(settingsForm().getByRole('checkbox', { name: 'Include draft pull requests' })).toBeChecked();
  await expect(settingsForm().getByLabel('Labels to watch')).toHaveValue('bug\nrelease');
  await expect(settingsForm().getByLabel('Channel per repository: value for repository 1')).toHaveValue('#propr');
  await expect(step(page, 'Configure')).toHaveAttribute('data-done', 'true');

  await step(page, 'Configure').getByRole('checkbox', { name: 'integry/propr', exact: true }).check();
  await step(page, 'Configure').getByRole('button', { name: 'Save repositories' }).click();
  await expect(page.getByTestId('plugin-repository-limit')).toHaveText('Limited to integry/propr.');
  expect(state.repositories).toEqual(['integry/propr']);

  await step(page, 'Enable').getByRole('checkbox', { name: /Enabled/ }).check();
  await expect(badge(page)).toHaveText('Degraded'); // the OAuth account is still to sign in
  await expect(page.getByTestId('plugin-contributions')).toContainText('MCP server example-remote · Active');
  state.oauth = true;
  await page.reload();
  await expect(badge(page)).toHaveText('Enabled');
  await capture(page, 'plugins-enabled-desktop', step(page, 'Configure'));

  // The managed items in Skills & MCP servers: badged, linked to the plugin, definition read-only.
  await page.getByTestId('plugin-contributions').getByRole('link', { name: 'Skills & MCP servers' }).first().click();
  const library = page.getByRole('region', { name: 'Skills & MCP servers' });
  const local = library.getByTestId('extension-server').filter({ hasText: 'example-local' });
  await expect(local.getByRole('link', { name: 'From plugin: Example pack' })).toHaveAttribute('href', '/plugins/example-pack');
  await expect(library.getByTestId('extension-skill').getByRole('link', { name: 'From plugin: Example pack' })).toBeVisible();
  await expect(local.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  const own = library.getByTestId('extension-server').filter({ has: page.getByText('docs', { exact: true }) });
  await expect(own.getByRole('button', { name: 'Remove' })).toHaveCount(1);
  await expect(own.getByTestId('extension-managed-badge')).toHaveCount(0);
  await local.getByRole('button', { name: 'Edit limits' }).click();
  const managedForm = library.getByTestId('extension-server-form');
  await expect(managedForm.getByTestId('extension-managed-definition')).toContainText('propr-fixture-mcp');
  await expect(managedForm.getByTestId('extension-managed-definition')).toContainText('FIXTURE_TOKEN');
  await expect(managedForm.getByLabel('Package')).toHaveCount(0);
  await expect(managedForm.getByRole('checkbox', { name: /Apply automatically/ })).toBeEnabled();
  await capture(page, 'plugins-managed-item-library-desktop', managedForm);
  await managedForm.getByRole('button', { name: 'Cancel' }).click();
  await local.getByRole('link', { name: 'From plugin: Example pack' }).click();
  await expect(badge(page)).toHaveText('Enabled');

  await step(page, 'Enable').getByRole('checkbox', { name: /Enabled/ }).uncheck();
  await expect(badge(page)).toHaveText('Off');

  await page.getByRole('button', { name: 'Uninstall…' }).click();
  await expect(page.getByTestId('plugin-uninstall-confirm')).toContainText('Skill example-notes from Skills & MCP servers');
  await page.getByRole('button', { name: 'Uninstall Example pack' }).click();
  await expect(page.getByTestId('plugin-uninstall-error')).toHaveText(REFUSAL);
  await capture(page, 'plugins-uninstall-refused-desktop', page.getByTestId('plugin-contributions'));
  await page.getByRole('button', { name: 'Uninstall Example pack' }).click();
  await expect(badge(page)).toHaveText('Not installed');
});

test('shows what an upgrade asks for and approving it clears Needs approval', async ({ page }) => {
  const state: State = { installed: true, enabled: true, token: true, oauth: true, repositories: null, refuseUninstall: false, settings: { ...DEFAULTS }, upgrade: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page, state);
  await page.goto('/plugins/example-pack');
  await expect(badge(page)).toHaveText('Needs approval');
  const approval = page.getByTestId('plugin-approval');
  await expect(approval).toContainText('Version 0.2.0 needs your approval (approved: 0.1.0)');
  await expect(approval.getByTestId('plugin-approval-permissions')).toContainText('pull_requests.read: Read pull requests and their status');
  await expect(approval.getByTestId('plugin-approval-package')).toContainText('Version changes from 1.0.0 to 1.1.0');
  await expect(approval.getByTestId('plugin-approval-package')).toContainText('Secret variables added: FIXTURE_REGION');
  const approve = approval.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeDisabled();
  await capture(page, 'plugins-needs-approval-desktop', approval);
  await approval.getByRole('checkbox', { name: /propr-fixture-mcp@1\.1\.0 receives the secret variables FIXTURE_TOKEN, FIXTURE_REGION/ }).check();
  await approve.click();
  await expect(badge(page)).toHaveText('Enabled');
  await expect(page.getByTestId('plugin-approval')).toHaveCount(0);
  expect(state.upgrade).toBe(false);
});

test('keeps the plugin steps usable on a phone', async ({ page }) => {
  const state: State = { installed: true, enabled: false, token: false, oauth: false, repositories: null, refuseUninstall: false };
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixture(page, state);
  await page.goto('/plugins/example-pack');
  await expect(badge(page)).toHaveText('Needs connection');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await capture(page, 'plugins-detail-phone');
  await capture(page, 'plugins-enable-blocked-phone', step(page, 'Enable'));
});
