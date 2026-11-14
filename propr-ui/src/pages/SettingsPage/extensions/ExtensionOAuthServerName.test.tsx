import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision, ExtensionLibraryServer } from '@propr/shared';
import AgentExtensionsSection from '../AgentExtensionsSection';
import { disconnectExtensionOAuth, getExtensionLibrary, startExtensionOAuth } from '../../../api/extensionProfilesApi';

vi.mock('../../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn(), saveExtensionLibrary: vi.fn(), setExtensionItemEnabled: vi.fn(), extensionLibraryHistory: vi.fn(),
  validateExtensionLibrary: vi.fn(), importArchiveSkill: vi.fn(), importGithubSkill: vi.fn(), discoverExtensionTools: vi.fn(),
  listGithubSkillRefs: vi.fn(), resolveGithubSkillRef: vi.fn(), resolveExtensionPackage: vi.fn(),
  checkExtensionOAuth: vi.fn(), startExtensionOAuth: vi.fn(), disconnectExtensionOAuth: vi.fn(),
}));
vi.mock('../../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({
  agents: [{ alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] }],
  repositories: [{ name: 'example/docs', enabled: true }],
}) }));

// The only valid server name (lowercase, ^[a-z][a-z0-9_-]*$) that every plain object also inherits.
const INHERITED_NAMES = ['constructor'];
const server = (name: string): ExtensionLibraryServer => ({
  kind: 'https', name, url: `https://${name}.example.com/mcp`, enabled: true, tools: ['search'], capability: 'read',
  authentication: 'oauth', repositories: [], agents: [], autoApply: true,
} as ExtensionLibraryServer);
const library = (names: string[]): ExtensionLibraryRevision => ({
  instanceId: 'instance', revision: 1, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1', servers: names.map(server), skills: [], skillBundles: [], secrets: {},
} as ExtensionLibraryRevision);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const row = async (name: string) => {
  const rows = await screen.findAllByTestId('extension-oauth-connection');
  const match = rows.find(element => element.closest('li')?.textContent?.includes(name) ?? false);
  if (!match) throw new Error(`no OAuth row for ${name}`);
  return match;
};

describe('OAuth actions for server names that match inherited object properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockReturnValue({ opener: null, location: { href: '' }, close: vi.fn() } as unknown as Window);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(INHERITED_NAMES)('starts a sign-in for an unconnected server named %s and re-enables Connect afterwards', async name => {
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library: library([name]), bundles: [], catalog: [],
      oauth: { redirectUri: 'https://propr.example.com/callback', clientMetadataUrl: null, connections: { [name]: { state: 'not_connected' } } } } as never);
    const start = deferred<{ authorizationUrl: string }>();
    vi.mocked(startExtensionOAuth).mockReturnValue(start.promise);
    render(<AgentExtensionsSection />);
    const connection = await row(name);
    const connect = within(connection).getByRole('button', { name: 'Connect' });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);
    expect(startExtensionOAuth).toHaveBeenCalledWith(name);
    await waitFor(() => expect(within(connection).getByRole('button', { name: 'Connect' })).toBeDisabled());
    start.resolve({ authorizationUrl: 'https://auth.example.com/authorize' });
    await waitFor(() => expect(within(connection).getByRole('button', { name: 'Connect' })).toBeEnabled());
  });

  it.each(INHERITED_NAMES)('reconnects and disconnects a connected server named %s', async name => {
    const connected = { state: 'connected', connectedBy: '1', connectedAt: 0, scopes: ['read'] };
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library: library([name]), bundles: [], catalog: [],
      oauth: { redirectUri: 'https://propr.example.com/callback', clientMetadataUrl: null, connections: { [name]: connected } } } as never);
    vi.mocked(startExtensionOAuth).mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize' });
    const disconnect = deferred<{ revoked: boolean }>();
    vi.mocked(disconnectExtensionOAuth).mockReturnValue(disconnect.promise);
    render(<AgentExtensionsSection />);
    const connection = await row(name);
    expect(within(connection).getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    fireEvent.click(within(connection).getByRole('button', { name: 'Reconnect' }));
    expect(startExtensionOAuth).toHaveBeenCalledWith(name);
    await waitFor(() => expect(within(connection).getByRole('button', { name: 'Reconnect' })).toBeEnabled());
    fireEvent.click(within(connection).getByRole('button', { name: 'Disconnect' }));
    const confirm = within(connection).getByRole('button', { name: 'Confirm disconnect' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(disconnectExtensionOAuth).toHaveBeenCalledWith(name);
    await waitFor(() => expect(within(connection).getByRole('button', { name: 'Reconnect' })).toBeDisabled());
    disconnect.resolve({ revoked: true });
    await waitFor(() => expect(within(connection).getByRole('button', { name: 'Reconnect' })).toBeEnabled());
    expect(within(connection).queryByText('Working…')).toBeNull();
  });
});
