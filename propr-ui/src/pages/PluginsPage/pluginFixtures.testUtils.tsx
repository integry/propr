import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PluginView } from '../../api/pluginsApi';
import type { CurrentUser } from '../../api/proprTypes';
import { AuthProvider } from '../../contexts/AuthContext';
import PluginsPage from './index';

export const admin: CurrentUser = {
  id: '42', login: 'octo', username: 'octo', displayName: 'Octo', email: null, avatarUrl: null,
  role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local',
};
export const member: CurrentUser = { ...admin, id: '7', role: 'member', permissions: [] };

/** The settings schema of the example plugin manifest: one setting of every type. */
export const EXAMPLE_SETTINGS = {
  type: 'object' as const,
  properties: {
    greeting: { type: 'string' as const, label: 'Greeting', help: 'Text the local example server prefixes to every echo.', default: 'hello' },
    verbosity: { type: 'string' as const, label: 'Verbosity', enum: ['quiet', 'normal', 'detailed'], default: 'normal' },
    maxItems: { type: 'number' as const, label: 'Maximum items', minimum: 1, maximum: 50, integer: true, default: 10 },
    includeDrafts: { type: 'boolean' as const, label: 'Include draft pull requests', default: false },
    labels: { type: 'array' as const, items: { type: 'string' as const }, label: 'Labels to watch', default: [] },
    channels: { type: 'object' as const, format: 'repository-map' as const, additionalProperties: { type: 'string' as const }, label: 'Channel per repository', help: 'Maps owner/repo to a channel name.' },
  },
  required: ['verbosity'],
};
/** The settings a fresh installation of the example plugin starts with. */
export const EXAMPLE_DEFAULTS = { greeting: 'hello', verbosity: 'normal', maxItems: 10, includeDrafts: false, labels: [] };

/** The example plugin as the API reads it before it is installed. */
export function examplePlugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'example-pack', available: true, state: 'available', installation: null,
    manifest: {
      id: 'example-pack', name: 'Example pack', description: 'A small development plugin.', version: '0.1.0', category: 'other',
      homepage: 'https://github.com/integry/propr/tree/main/packages/plugins/example-pack',
      permissions: [{ name: 'events.read', description: 'Receive ProPR task, pull request and automation events' }, { name: 'tasks.read', description: 'Read tasks and their status' }],
      connections: [
        { type: 'oauth', name: 'example-account', label: 'Example account', help: 'Sign in with the example service account.', helpUrl: 'https://example.com/docs/oauth' },
        { type: 'token', name: 'example-token', label: 'Example API token', help: 'Create a read-only API token.', helpUrl: 'https://example.com/docs/tokens' },
      ],
      settings: EXAMPLE_SETTINGS,
      outboundHosts: ['api.example.com'],
      contributes: {
        mcpServers: [
          { kind: 'https', name: 'example-remote', url: 'https://mcp.example.com/mcp', tools: ['search'], capability: 'read', authentication: 'oauth', connection: 'example-account' },
          { kind: 'package', name: 'example-local', ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', tools: ['echo'], capability: 'read', secretEnv: [{ name: 'FIXTURE_TOKEN', connection: 'example-token' }] },
        ],
        skills: ['example-notes'], automationTemplates: ['example-weekly-digest'], commands: [{ name: 'deploy', description: 'Deploy' }], subscriptions: [], webhooks: [],
      },
    },
    connections: [
      { name: 'example-account', type: 'oauth', label: 'Example account', state: 'not_connected', required: false },
      { name: 'example-token', type: 'token', label: 'Example API token', state: 'not_connected', required: true },
    ],
    needsApproval: false, pendingPermissions: [], pendingAcknowledgements: [], enableBlockers: [],
    contributions: {
      mcpServers: [
        { name: 'example-remote', kind: 'https', managed: null, href: '/api/instance/extensions/v1' },
        { name: 'example-local', kind: 'package', managed: null, href: '/api/instance/extensions/v1' },
      ],
      skills: [{ name: 'example-notes', managed: null, href: '/api/instance/extensions/v1' }],
      automationTemplates: [{ id: 'example-weekly-digest', catalogId: 'example-weekly-digest', available: false, href: '/api/automation-definitions/templates' }],
    },
    ...overrides,
  };
}

type Step = 'installed' | 'connected' | 'enabled';
/** The example plugin after each step of the page. */
export function exampleAt(step: Step, repositories: string[] | null = null): PluginView {
  const base = examplePlugin();
  const enabled = step === 'enabled';
  const tokenSet = step !== 'installed';
  const active = enabled;
  return {
    ...base, state: enabled ? 'enabled' : 'installed',
    installation: {
      installedVersion: '0.1.0', enabled, settings: { ...EXAMPLE_DEFAULTS }, repositories, grantedPermissions: ['events.read', 'tasks.read'],
      acknowledgements: { 'example-local': { actor: '42', at: 1, package: 'propr-fixture-mcp', version: '1.0.0', secretEnv: ['FIXTURE_TOKEN'] } },
      installedBy: '42', installedAt: Date.UTC(2026, 10, 14), updatedBy: '42', updatedAt: Date.UTC(2026, 10, 14),
    },
    connections: [
      { name: 'example-account', type: 'oauth', label: 'Example account', state: tokenSet ? 'connected' : 'not_connected', required: false },
      { name: 'example-token', type: 'token', label: 'Example API token', state: tokenSet ? 'connected' : 'not_connected', required: true, ...(tokenSet ? { setBy: '42', setAt: Date.UTC(2026, 10, 14) } : {}) },
    ],
    enableBlockers: tokenSet ? [] : ['Connection Example API token (example-token) is not set'],
    contributions: {
      mcpServers: [
        { name: 'example-remote', kind: 'https', managed: { kind: 'server', name: 'example-remote', enabled: true, active }, href: '/api/instance/extensions/v1' },
        { name: 'example-local', kind: 'package', managed: { kind: 'server', name: 'example-local', enabled: true, active }, href: '/api/instance/extensions/v1' },
      ],
      skills: [{ name: 'example-notes', managed: { kind: 'skill', bundleId: 'bundle-1', enabled: true, active }, href: '/api/instance/extensions/v1' }],
      automationTemplates: [{ id: 'example-weekly-digest', catalogId: 'example-weekly-digest', available: enabled, href: '/api/automation-definitions/templates' }],
    },
  };
}

export function renderPluginsPage(path = '/plugins', user: CurrentUser | null = admin) {
  return render(
    <AuthProvider user={user}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/plugins/:pluginId?" element={<PluginsPage />} />
          <Route path="/settings" element={<p>Settings page</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}
