import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlugin, getPluginActivity, getPluginWebhooks, PluginApiError, regeneratePluginWebhookKey, type PluginView, type PluginWebhooksView } from '../../api/pluginsApi';
import { exampleAt, renderPluginsPage } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPlugin: vi.fn(), getPluginActivity: vi.fn(), getPluginWebhooks: vi.fn(), regeneratePluginWebhookKey: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ agents: [], repositories: [{ name: 'acme/web' }] }) }));
vi.mock('../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn().mockResolvedValue({ oauth: { redirectUri: 'https://propr.example.com/api/instance/extensions/v1/oauth/callback', clientMetadataUrl: null, connections: {} } }),
}));

const OLD_KEY = 'Q3b9xYw1t0P8mN2k5JhGfDsAaZxCvBnMlKjHgFdSaQw';
const NEW_KEY = 'n7Fq2Lr8Xc4Vb1Mz9Kp3Wd6Ys0Gh5Jt2Ue8Ri4Oa1Qs';
const urls = (key: string, url = true): PluginWebhooksView => ({
  webhooks: [
    { name: 'events', description: 'Example service events', scheme: 'hmac-sha256', path: `/api/plugins/${key}/hooks/events`, url: url ? `https://propr.example.com/api/plugins/${key}/hooks/events` : null },
    { name: 'slack', description: 'Slack Events API', scheme: 'slack-v0', path: `/api/plugins/${key}/hooks/slack`, url: url ? `https://propr.example.com/api/plugins/${key}/hooks/slack` : null },
  ],
  rejected: { count: 2, lastAt: Date.UTC(2026, 10, 15, 9), lastReason: 'bad_signature' },
  keyCreatedAt: Date.UTC(2026, 10, 14), keyCreatedBy: 'system',
});
/** The example plugin, installed, declaring two webhooks verified with a signing secret. */
function withWebhooks(): PluginView {
  const view = exampleAt('connected');
  const manifest = view.manifest!;
  return {
    ...view,
    manifest: {
      ...manifest,
      connections: [...manifest.connections, { type: 'signing_secret', name: 'example-signing', label: 'Signing secret', help: 'The webhook signing secret.', helpUrl: 'https://example.com/docs/webhooks' }],
      contributes: { ...manifest.contributes, webhooks: [{ name: 'events', description: 'Example service events', scheme: 'hmac-sha256' }, { name: 'slack', description: 'Slack Events API', scheme: 'slack-v0' }] },
    },
    connections: [...view.connections, { name: 'example-signing', type: 'signing_secret', label: 'Signing secret', state: 'connected', required: false, setBy: '42', setAt: 1 }],
  };
}
const open = async (view: PluginView = withWebhooks()) => {
  vi.mocked(getPlugin).mockResolvedValue({ plugin: { ...view, audit: [] } });
  renderPluginsPage('/plugins/example-pack');
  await screen.findByRole('heading', { level: 1, name: /Example pack/ });
};
const region = () => screen.getByRole('region', { name: 'Webhook URLs' });

describe('Plugin webhook URLs', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPluginActivity).mockResolvedValue({ health: { state: 'healthy', consecutiveFailures: 0, pauseAfterFailures: 10, lastError: null, lastErrorAt: null, degradedAt: null, pausedAt: null }, deliveries: [] });
    vi.mocked(getPluginWebhooks).mockResolvedValue(urls(OLD_KEY));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the URL of each webhook in the Connect step, with its verification scheme, Copy and the rejected count', async () => {
    await open();
    const events = await screen.findByRole('textbox', { name: 'URL of webhook events' });
    expect(getPluginWebhooks).toHaveBeenCalledWith('example-pack');
    expect(events).toHaveValue(`https://propr.example.com/api/plugins/${OLD_KEY}/hooks/events`);
    expect(events).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'URL of webhook slack' })).toHaveValue(`https://propr.example.com/api/plugins/${OLD_KEY}/hooks/slack`);
    const items = within(region()).getAllByTestId('plugin-webhook');
    expect(items[0]).toHaveTextContent('Example service events');
    expect(items[0]).toHaveTextContent('HMAC-SHA256 signature');
    expect(items[1]).toHaveTextContent('Slack signing secret');
    expect(region()).toHaveTextContent('2 unverified requests rejected');
    expect(region()).toHaveTextContent('(wrong signature)');
    expect(within(screen.getByRole('heading', { name: /Connect/ }).closest('section')!).getByRole('region', { name: 'Webhook URLs' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy URL of webhook slack' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://propr.example.com/api/plugins/${OLD_KEY}/hooks/slack`));
    expect(await within(region()).findByText('Copied')).toBeInTheDocument();
  });

  it('regenerates the key after a confirmation and shows the new URLs', async () => {
    vi.mocked(regeneratePluginWebhookKey).mockResolvedValue({ ...urls(NEW_KEY), rejected: { count: 0, lastAt: null, lastReason: null } });
    await open();
    await screen.findByRole('textbox', { name: 'URL of webhook events' });
    fireEvent.click(within(region()).getByRole('button', { name: 'Regenerate' }));
    expect(regeneratePluginWebhookKey).not.toHaveBeenCalled();
    const confirmation = within(region()).getByRole('group', { name: 'Confirm regenerate' });
    expect(confirmation).toHaveTextContent('Every URL above stops working at once');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(regeneratePluginWebhookKey).not.toHaveBeenCalled();

    fireEvent.click(within(region()).getByRole('button', { name: 'Regenerate' }));
    fireEvent.click(within(region()).getByRole('button', { name: 'Regenerate URLs' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'URL of webhook events' })).toHaveValue(`https://propr.example.com/api/plugins/${NEW_KEY}/hooks/events`));
    expect(regeneratePluginWebhookKey).toHaveBeenCalledWith('example-pack');
    expect(within(region()).getByRole('status')).toHaveTextContent('the old URLs no longer work');
    expect(region()).toHaveTextContent('No unverified requests.');
  });

  it('shows the path when the instance has no public base URL, and a refusal verbatim', async () => {
    vi.mocked(getPluginWebhooks).mockResolvedValue(urls(OLD_KEY, false));
    vi.mocked(regeneratePluginWebhookKey).mockRejectedValue(new PluginApiError(403, 'Current durable instance administrator access is required'));
    await open();
    expect(await screen.findByRole('textbox', { name: 'URL of webhook events' })).toHaveValue(`/api/plugins/${OLD_KEY}/hooks/events`);
    expect(region()).toHaveTextContent('no public base URL');
    fireEvent.click(within(region()).getByRole('button', { name: 'Regenerate' }));
    fireEvent.click(within(region()).getByRole('button', { name: 'Regenerate URLs' }));
    expect(await within(region()).findByRole('alert')).toHaveTextContent('Current durable instance administrator access is required');
    expect(screen.getByRole('textbox', { name: 'URL of webhook events' })).toHaveValue(`/api/plugins/${OLD_KEY}/hooks/events`);
  });

  it('is not shown for a plugin without webhooks or before it is installed', async () => {
    await open(exampleAt('connected'));
    await screen.findByRole('heading', { name: /Connect/ });
    expect(screen.queryByRole('region', { name: 'Webhook URLs' })).toBeNull();
    expect(getPluginWebhooks).not.toHaveBeenCalled();
  });
});
