import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The Plugins page end to end against a stateful plugin API fixture: the
 * example plugin is installed, connected, limited to a repository, enabled,
 * disabled and uninstalled entirely from the page. With PROPR_CAPTURE_PREVIEWS
 * set it also captures the catalog and the detail steps at desktop and phone widths.
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
  settings: { type: 'object', properties: {}, required: [] },
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

interface State { installed: boolean; enabled: boolean; token: boolean; oauth: boolean; repositories: string[] | null; refuseUninstall: boolean }

function view(state: State) {
  const active = state.enabled;
  const library = '/api/instance/extensions/v1';
  return {
    id: 'example-pack', available: true, manifest: MANIFEST,
    state: !state.installed ? 'available' : state.enabled ? 'enabled' : 'installed',
    installation: state.installed ? {
      installedVersion: '0.1.0', enabled: state.enabled, settings: {}, repositories: state.repositories, grantedPermissions: ['events.read', 'tasks.read'],
      acknowledgements: { 'example-local': { actor: '1042', at: NOW, package: 'propr-fixture-mcp', version: '1.0.0', secretEnv: ['FIXTURE_TOKEN'] } },
      installedBy: '1042', installedAt: NOW, updatedBy: '1042', updatedAt: NOW,
    } : null,
    connections: [
      { name: 'example-account', type: 'oauth', label: 'Example account', state: state.oauth ? 'connected' : 'not_connected', required: false },
      { name: 'example-token', type: 'token', label: 'Example API token', state: state.token ? 'connected' : 'not_connected', required: true, ...(state.token ? { setBy: '1042', setAt: NOW } : {}) },
    ],
    needsApproval: false, pendingPermissions: [], pendingAcknowledgements: [],
    enableBlockers: state.installed && !state.token ? ['Connection Example API token (example-token) is not set'] : [],
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
    if (pathname === `${BASE}/example-pack/install`) {
      if (!(body.acknowledgements as string[] | undefined)?.includes('example-local')) return route.fulfill({ status: 400, json: { error: 'Confirm that the secret variables of example-local are readable' } });
      state.installed = true; return reply();
    }
    if (pathname === `${BASE}/example-pack/connections/example-token`) { state.token = body.value !== null; return reply(); }
    if (pathname === `${BASE}/example-pack/repositories`) { state.repositories = body.repositories as string[] | null; return reply(); }
    if (pathname === `${BASE}/example-pack/enabled`) { state.enabled = body.enabled === true; return reply(); }
    if (pathname === `${BASE}/example-pack/uninstall`) {
      if (state.refuseUninstall) { state.refuseUninstall = false; return route.fulfill({ status: 409, json: { error: REFUSAL } }); }
      Object.assign(state, { installed: false, enabled: false, token: false, oauth: false, repositories: null }); return reply();
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: '1042', login: 'preview', username: 'preview', displayName: 'Preview Operator', email: null, avatarUrl: null, role: 'admin',
        permissions: ['instance.manage_settings', 'instance.manage_members', 'instance.manage_agents'], authorizationSource: 'local',
      },
      '/api/instance/catalog': { agents: [], repositories: [{ name: 'integry/propr' }, { name: 'integry/propr-docs' }] },
      '/api/instance/extensions/v1': { oauth: { redirectUri: 'https://propr.example.com/api/instance/extensions/v1/oauth/callback', clientMetadataUrl: null, connections: {} } },
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

test('installs, connects, limits, enables, disables and uninstalls the example plugin from the page', async ({ page }) => {
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

  const configure = step(page, 'Configure');
  await configure.getByRole('checkbox', { name: 'integry/propr', exact: true }).check();
  await configure.getByRole('button', { name: 'Save repositories' }).click();
  await expect(page.getByTestId('plugin-repository-limit')).toHaveText('Limited to integry/propr.');
  expect(state.repositories).toEqual(['integry/propr']);

  await enable.getByRole('checkbox', { name: /Enabled/ }).check();
  await expect(badge(page)).toHaveText('Degraded'); // the OAuth account is still to sign in
  await expect(page.getByTestId('plugin-contributions')).toContainText('MCP server example-remote · Active');
  state.oauth = true;
  await page.reload();
  await expect(badge(page)).toHaveText('Enabled');
  await capture(page, 'plugins-enabled-desktop', step(page, 'Configure'));

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
