import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The plugin API fixture of the Plugins page specs: a stateful example plugin
 * (install, connections, settings, repository limit, enable, approval,
 * uninstall and delivery activity) behind `page.route`, and the preview
 * capture used with PROPR_CAPTURE_PREVIEWS.
 */

export const NOW = Date.parse('2026-11-14T09:00:00.000Z');
export const BASE = '/api/instance/plugins/v1';
export const REFUSAL = 'Automations add items of plugin example-pack explicitly; remove them from "Weekly digest" (example-remote) before uninstalling';

export const MANIFEST = {
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
    skills: ['example-notes'], automationTemplates: ['example-weekly-digest'], subscriptions: [], webhooks: [],
    commands: [{ name: 'example-notes', description: 'Write release notes for the work so far', where: ['pull_request', 'issue'], kind: 'prompt', skills: ['example-notes'], servers: ['example-remote'], needsWrite: false, shared: false, specific: [] }],
  },
};
export const OTHERS = [
  { id: 'team-chat', name: 'Team chat', category: 'messaging', description: 'Posts task and pull request updates to a chat channel.' },
  { id: 'deploy-hooks', name: 'Deploy hooks', category: 'deployment', description: 'Adds the /deploy command and reports deployment status.' },
];

export const DEFAULTS = { greeting: 'hello', verbosity: 'normal', maxItems: 10, includeDrafts: false, labels: [] };
/** The upgrade awaiting approval: version 0.2.0 asks for one more permission and moves the package server to a new version with one more secret variable. */
export const UPGRADE = { version: '0.2.0', permission: { name: 'pull_requests.read', description: 'Read pull requests and their status' }, package: 'propr-fixture-mcp', packageVersion: '1.1.0', secretEnv: ['FIXTURE_TOKEN', 'FIXTURE_REGION'] };

export interface Delivery {
  id: number; deliveryId: string; kind: 'event' | 'gap'; repository: string; eventSeq: number; eventType: string | null; handler: string | null;
  status: 'pending' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'skipped'; attempt: number; nextAttemptAt: number | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null; durationMs: number | null; timedOut: boolean; error: string | null;
  logs: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; at: number }[];
}
export interface Health {
  state: 'healthy' | 'degraded' | 'paused'; consecutiveFailures: number; pauseAfterFailures: number;
  lastError: string | null; lastErrorAt: number | null; degradedAt: number | null; pausedAt: number | null;
}

export interface State {
  installed: boolean; enabled: boolean; token: boolean; oauth: boolean; repositories: string[] | null; refuseUninstall: boolean;
  settings?: Record<string, unknown>; upgrade?: boolean;
  activity?: { health: Health; deliveries: Delivery[] };
}

export const HEALTHY: Health = { state: 'healthy', consecutiveFailures: 0, pauseAfterFailures: 10, lastError: null, lastErrorAt: null, degradedAt: null, pausedAt: null };
/** The plugin's delivery activity routes: null when the path is not one. */
export function activityRoute(state: State, route: string, method: string): { status: number; json: unknown } | null {
  const activity = state.activity ?? { health: HEALTHY, deliveries: [] };
  if (route === '/activity' && method === 'GET') return { status: 200, json: activity };
  const retry = /^\/activity\/(\d+)\/retry$/.exec(route);
  if (retry && method === 'POST') {
    const delivery = activity.deliveries.find(d => d.id === Number(retry[1]));
    if (!delivery || delivery.status !== 'failed') return { status: 409, json: { error: 'Only a failed event delivery can be retried' } };
    Object.assign(delivery, { status: 'pending', nextAttemptAt: NOW });
    return { status: 200, json: { delivery } };
  }
  if (route === '/resume' && method === 'POST') {
    if (activity.health.state !== 'paused') return { status: 409, json: { error: 'Deliveries of this plugin are not paused' } };
    activity.health = { ...HEALTHY, lastError: activity.health.lastError, lastErrorAt: activity.health.lastErrorAt };
    return { status: 200, json: { health: activity.health } };
  }
  return null;
}

export const blockers = (state: State) => [
  ...(state.settings?.verbosity === undefined ? ['Required setting Verbosity (verbosity) is missing'] : []),
  ...(state.token ? [] : ['Connection Example API token (example-token) is not set']),
];

export function view(state: State) {
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
export function upgradedManifest() {
  const servers = MANIFEST.contributes.mcpServers.map(server => (server.kind === 'package'
    ? { ...server, version: UPGRADE.packageVersion, secretEnv: UPGRADE.secretEnv.map(name => ({ name, connection: 'example-token' })) } : server));
  return { ...MANIFEST, version: UPGRADE.version, permissions: [...MANIFEST.permissions, UPGRADE.permission], contributes: { ...MANIFEST.contributes, mcpServers: servers } };
}

/** The extension library as Skills & MCP servers reads it: the plugin's managed items once it is installed, next to one own server. */
export function extensionLibrary(state: State) {
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
export function saveSettings(state: State, settings: Record<string, unknown>) {
  if (typeof settings.maxItems === 'number' && (settings.maxItems < 1 || settings.maxItems > 50)) return { status: 400, error: `maxItems must be ${settings.maxItems < 1 ? 'at least 1' : 'at most 50'}` };
  if (state.enabled && settings.verbosity === null) return { status: 409, error: 'Required settings cannot be removed while the plugin is enabled: verbosity' };
  state.settings = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== null));
  return null;
}

export const ACKNOWLEDGE = 'Confirm that the secret variables of example-local are readable';
export const acknowledges = (body: Record<string, unknown>) => (body.acknowledgements as string[] | undefined)?.includes('example-local');
/** The example plugin's mutation routes: null when the path is not one, a refusal, or `{}` once the state changed. */
export function pluginMutation(state: State, route: string, body: Record<string, unknown>): { status?: number; error?: string } | null {
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

export const otherView = (other: typeof OTHERS[number], enabled: boolean) => ({
  ...view({ installed: enabled, enabled, token: true, oauth: true, repositories: null, refuseUninstall: false }),
  id: other.id, manifest: { ...MANIFEST, ...other, connections: [], contributes: { ...MANIFEST.contributes, mcpServers: [] } }, connections: [],
});

export async function installFixture(page: Page, state: State): Promise<void> {
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
    const activity = pathname.startsWith(`${BASE}/example-pack/`) ? activityRoute(state, pathname.slice(`${BASE}/example-pack`.length), method) : null;
    if (activity) return route.fulfill(activity);
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
export async function capture(page: Page, name: string, focus?: ReturnType<Page['locator']>): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  if (focus) await focus.evaluate(element => element.scrollIntoView({ block: 'start' }));
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

export const step = (page: Page, title: string) => page.getByRole('region', { name: new RegExp(`^\\d\\. ${title}`) });
export const badge = (page: Page) => page.getByRole('heading', { level: 1 }).getByTestId('plugin-state');
