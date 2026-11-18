import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlugin, getPluginActivity, type PluginView } from '../../api/pluginsApi';
import { exampleAt, renderPluginsPage } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPlugin: vi.fn(), getPluginActivity: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ agents: [], repositories: [{ name: 'acme/web' }] }) }));
vi.mock('../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn().mockResolvedValue({ oauth: { redirectUri: 'https://propr.example.com/api/instance/extensions/v1/oauth/callback', clientMetadataUrl: null, connections: {} } }),
}));

/** The example plugin, installed, with a webhook URL connection (a token with `secretUrl`), as the chat plugins declare them. */
function withWebhookUrl(): PluginView {
  const view = exampleAt('connected');
  const manifest = view.manifest!;
  return {
    ...view,
    manifest: {
      ...manifest,
      connections: [...manifest.connections, {
        type: 'token', name: 'default-webhook', label: 'Default webhook URL', help: 'Paste a Slack incoming webhook URL.', helpUrl: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks',
        secretUrl: { hosts: ['hooks.slack.com', 'hooks.slack-gov.com'], pathPrefixes: ['/services/'] },
      }],
    },
    connections: [...view.connections, { name: 'default-webhook', type: 'token', label: 'Default webhook URL', state: 'connected', required: false, setBy: '42', setAt: 1 }],
  };
}

describe('Plugin webhook URL connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPluginActivity).mockResolvedValue({ health: { state: 'healthy', consecutiveFailures: 0, pauseAfterFailures: 10, lastError: null, lastErrorAt: null, degradedAt: null, pausedAt: null }, deliveries: [] });
  });

  it('marks the Connect step done and the plugin Enabled with an optional webhook URL left unset, and labels it optional', async () => {
    const view = withWebhookUrl();
    const enabled = exampleAt('enabled');
    vi.mocked(getPlugin).mockResolvedValue({ plugin: {
      ...view, state: 'enabled', installation: enabled.installation, contributions: enabled.contributions,
      connections: view.connections.map(c => (c.name === 'default-webhook' ? { name: 'default-webhook', type: 'token' as const, label: 'Default webhook URL', state: 'not_connected' as const, required: false } : c)),
      audit: [],
    } });
    renderPluginsPage('/plugins/example-pack');
    await screen.findByRole('heading', { level: 1, name: /Example pack/ });
    const connect = screen.getAllByTestId('plugin-step').find(s => s.querySelector('h2')?.textContent?.includes('Connect'))!;
    expect(connect).toHaveAttribute('data-done', 'true');
    const optional = within(connect).getAllByTestId('plugin-connection').find(item => item.textContent?.includes('Default webhook URL'))!;
    expect(optional).toHaveTextContent('Webhook URL · optional');
    const token = within(connect).getAllByTestId('plugin-connection').find(item => item.textContent?.includes('Example API token'))!;
    expect(token).toHaveTextContent('· required to enable');
    expect(token).not.toHaveTextContent('optional');
    expect(screen.queryByText('Degraded')).toBeNull();
  });

  it('labels a secret URL connection as a webhook URL, names its accepted hosts and never shows the stored URL', async () => {
    vi.mocked(getPlugin).mockResolvedValue({ plugin: { ...withWebhookUrl(), audit: [] } });
    renderPluginsPage('/plugins/example-pack');
    await screen.findByRole('heading', { level: 1, name: /Example pack/ });
    const row = screen.getAllByTestId('plugin-connection').find(item => item.textContent?.includes('Default webhook URL'))!;
    expect(row).toHaveTextContent('Webhook URL');
    expect(row).not.toHaveTextContent('API token');
    expect(row).toHaveTextContent('Stored by administrator 42');
    expect(row).toHaveTextContent('ProPR never shows it again.');
    const field = within(row).getByLabelText('Replace Default webhook URL');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveValue('');
    expect(field).toHaveAccessibleDescription('Accepted only on hooks.slack.com, hooks.slack-gov.com.');
    // An ordinary token connection keeps its label and has no host line.
    const token = screen.getAllByTestId('plugin-connection').find(item => item.textContent?.includes('Example API token'))!;
    expect(token).toHaveTextContent('API token');
    expect(token).not.toHaveTextContent('Accepted only on');
  });
});
