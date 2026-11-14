import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLibraryRevision, ExtensionOAuthInstanceInfo } from '@propr/shared';
import AgentExtensionsSection from './AgentExtensionsSection';
import { checkExtensionOAuth, disconnectExtensionOAuth, getExtensionLibrary, saveExtensionLibrary, startExtensionOAuth } from '../../api/extensionProfilesApi';

vi.mock('../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn(), saveExtensionLibrary: vi.fn(), setExtensionItemEnabled: vi.fn(), extensionLibraryHistory: vi.fn(),
  validateExtensionLibrary: vi.fn(), importArchiveSkill: vi.fn(), importGithubSkill: vi.fn(), discoverExtensionTools: vi.fn(),
  listGithubSkillRefs: vi.fn(), resolveGithubSkillRef: vi.fn(), checkExtensionOAuth: vi.fn(), startExtensionOAuth: vi.fn(), disconnectExtensionOAuth: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ agents: [], repositories: [] }) }));

const REDIRECT = 'https://propr.example.com/api/instance/extensions/v1/oauth/callback';
const server = (name: string) => ({ kind: 'https' as const, name, url: `https://${name}.example.com/mcp`, enabled: true, tools: ['search'], capability: 'read' as const, authentication: 'oauth' as const, repositories: [], agents: [], autoApply: true });
const library: ExtensionLibraryRevision = {
  instanceId: 'instance', revision: 5, version: 1, createdAt: 0, updatedAt: 0, auditActor: '1',
  servers: [server('linear'), server('notion'), server('sentry')], skills: [], secrets: {}, skillBundles: [],
};
const oauth = (connections: ExtensionOAuthInstanceInfo['connections'], redirectUri: string | null = REDIRECT): ExtensionOAuthInstanceInfo => ({ redirectUri, clientMetadataUrl: redirectUri && 'https://propr.example.com/api/instance/extensions/v1/oauth/client-metadata.json', connections });
const threeStates = oauth({
  linear: { state: 'not_connected' },
  notion: { state: 'connected', connectedBy: '42', connectedAt: Date.UTC(2026, 10, 12, 9, 30), scopes: ['read:docs', 'search'], registration: 'dynamic' },
  sentry: { state: 'needs_sign_in', connectedBy: '42', connectedAt: Date.UTC(2026, 10, 1), scopes: ['issues.read'], registration: 'preregistered' },
});
const rowOf = (view: HTMLElement, name: string) => within(view).getAllByTestId('extension-server').find(row => row.textContent?.includes(name))!;
const section = async () => {
  render(<AgentExtensionsSection />);
  await screen.findByText(/Revision 5/);
  return screen.getByRole('region', { name: 'Skills & MCP servers' });
};

describe('OAuth MCP servers in Skills & MCP servers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [], oauth: threeStates });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows Not connected, Connected and Needs sign-in with who connected, when, the granted scopes and the matching actions', async () => {
    const view = await section();
    const linear = within(rowOf(view, 'linear')).getByTestId('extension-oauth-connection');
    expect(linear).toHaveAttribute('data-state', 'not_connected');
    expect(linear).toHaveTextContent('Not connected');
    expect(linear).toHaveTextContent('Runs skip this server until an administrator connects it.');
    expect(within(linear).getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(within(linear).queryByRole('button', { name: 'Disconnect' })).toBeNull();

    const notion = within(rowOf(view, 'notion')).getByTestId('extension-oauth-connection');
    expect(notion).toHaveTextContent('Connected');
    expect(notion).toHaveTextContent('by administrator 42');
    expect(notion).toHaveTextContent('Granted scopes: read:docs, search');
    expect(within(notion).getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    expect(within(notion).getByRole('button', { name: 'Disconnect' })).toBeEnabled();

    const sentry = within(rowOf(view, 'sentry')).getByTestId('extension-oauth-connection');
    expect(sentry).toHaveTextContent('Needs sign-in');
    expect(sentry).toHaveTextContent('The provider refused to refresh the connection.');
    expect(within(sentry).getByRole('button', { name: 'Reconnect' })).toBeEnabled();
  });

  it('Connect opens the provider in a detached new tab and refreshes the state when the tab regains focus', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(startExtensionOAuth).mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize?state=s' });
    const view = await section();
    fireEvent.click(within(rowOf(view, 'linear')).getByRole('button', { name: 'Connect' }));
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://auth.example.com/authorize?state=s'));
    expect(tab.opener).toBeNull();
    expect(startExtensionOAuth).toHaveBeenCalledWith('linear');
    expect(await screen.findByText(/Finish signing in to linear in the new tab/)).toBeInTheDocument();
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [], oauth: oauth({ ...threeStates.connections, linear: { state: 'connected', connectedBy: '1', connectedAt: Date.now(), scopes: ['issues:read'], registration: 'metadata_document' } }) });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(within(rowOf(view, 'linear')).getByTestId('extension-oauth-connection')).toHaveAttribute('data-state', 'connected'));
    expect(within(rowOf(view, 'linear')).getByTestId('extension-oauth-connection')).toHaveTextContent('Granted scopes: issues:read');
  });

  it('Reconnect keeps refreshing after a return to Settings before consent, until the new connection is shown', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(startExtensionOAuth).mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize?state=r' });
    const view = await section();
    fireEvent.click(within(rowOf(view, 'notion')).getByRole('button', { name: 'Reconnect' }));
    expect(await screen.findByText(/Finish signing in to notion in the new tab/)).toBeInTheDocument();
    // Back in Settings before finishing consent: the original connection is still the one shown.
    const reads = vi.mocked(getExtensionLibrary).mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(vi.mocked(getExtensionLibrary).mock.calls.length).toBe(reads + 1));
    expect(within(rowOf(view, 'notion')).getByTestId('extension-oauth-connection')).toHaveTextContent('Granted scopes: read:docs, search');
    // Consent finished with other scopes and another account: the next return shows the new connection.
    const reconnected = { state: 'connected' as const, connectedBy: '7', connectedAt: Date.UTC(2026, 10, 13, 10), scopes: ['write:docs'], registration: 'dynamic' as const };
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [], oauth: oauth({ ...threeStates.connections, notion: reconnected }) });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(within(rowOf(view, 'notion')).getByTestId('extension-oauth-connection')).toHaveTextContent('Granted scopes: write:docs'));
    expect(within(rowOf(view, 'notion')).getByTestId('extension-oauth-connection')).toHaveTextContent('by administrator 7');
    // Finished: the listeners are gone.
    const settled = vi.mocked(getExtensionLibrary).mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(vi.mocked(getExtensionLibrary).mock.calls.length).toBe(settled);
  });

  it('a failed start closes the opened tab and explains why', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(startExtensionOAuth).mockRejectedValue(new Error('The authorization server supports no client registration ProPR can use.'));
    const view = await section();
    fireEvent.click(within(rowOf(view, 'linear')).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('linear could not start a sign-in: The authorization server supports no client registration');
    expect(tab.close).toHaveBeenCalled();
  });

  it('Disconnect asks for confirmation, then revokes and shows Not connected', async () => {
    vi.mocked(disconnectExtensionOAuth).mockResolvedValue({ revoked: true });
    const view = await section();
    fireEvent.click(within(rowOf(view, 'notion')).getByRole('button', { name: 'Disconnect' }));
    expect(disconnectExtensionOAuth).not.toHaveBeenCalled();
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [], oauth: oauth({ ...threeStates.connections, notion: { state: 'not_connected' } }) });
    fireEvent.click(within(rowOf(view, 'notion')).getByRole('button', { name: 'Confirm disconnect' }));
    expect(await screen.findByText('notion disconnected; the provider revoked its tokens.')).toBeInTheDocument();
    expect(disconnectExtensionOAuth).toHaveBeenCalledWith('notion');
    expect(within(rowOf(view, 'notion')).getByTestId('extension-oauth-connection')).toHaveAttribute('data-state', 'not_connected');
  });

  it('without a public base URL Connect is disabled with an explanation', async () => {
    vi.mocked(getExtensionLibrary).mockResolvedValue({ instanceId: 'instance', library, bundles: [], catalog: [], oauth: oauth(threeStates.connections, null) });
    const view = await section();
    const linear = within(rowOf(view, 'linear')).getByTestId('extension-oauth-connection');
    expect(within(linear).getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(linear).toHaveTextContent('Connect needs a public HTTPS base URL for this instance (API_PUBLIC_URL)');
  });

  it('the form offers OAuth sign-in with scopes, a pre-registered client, the redirect URI, the shared-identity warning and Check', async () => {
    vi.mocked(checkExtensionOAuth).mockResolvedValue({ check: { authorizationRequired: true, discoveredFrom: 'challenge', resource: 'https://tools.example.com/mcp', issuer: 'https://auth.example.com', scopes: ['docs.read'], registration: 'preregistered', message: 'Sign-in will use the client id you entered. Register the redirect URI below with the provider.', redirectUri: REDIRECT } });
    vi.mocked(saveExtensionLibrary).mockImplementation(async input => ({ library: { ...library, ...input, revision: 6 } as ExtensionLibraryRevision }));
    const view = await section();
    fireEvent.click(within(view).getByRole('button', { name: 'Add server' }));
    const form = screen.getByTestId('extension-server-form');
    fireEvent.change(within(form).getByLabelText(/^Server name/), { target: { value: 'docs' } });
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://tools.example.com/mcp' } });
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'oauth' } });
    const fields = within(form).getByTestId('extension-oauth-fields');
    expect(fields).toHaveTextContent('Every run this server applies to acts with the access of the account that signs in');
    expect(within(fields).getByTestId('extension-oauth-redirect-uri')).toHaveTextContent(REDIRECT);
    fireEvent.change(within(fields).getByLabelText(/^Scopes/), { target: { value: 'docs.read  docs.search' } });
    fireEvent.change(within(fields).getByLabelText(/^Client id/), { target: { value: 'console-client' } });
    fireEvent.change(within(fields).getByLabelText(/^Client secret/), { target: { value: 'console-secret' } });
    fireEvent.click(within(fields).getByRole('button', { name: 'Check' }));
    const check = await within(fields).findByTestId('extension-oauth-check');
    expect(check).toHaveTextContent('Authorization server: https://auth.example.com');
    expect(check).toHaveTextContent('Registration: Pre-registered client');
    expect(checkExtensionOAuth).toHaveBeenCalledWith('https://tools.example.com/mcp', { clientId: 'console-client', scopes: ['docs.read', 'docs.search'] });
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalled());
    const [input, , secrets] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(input.servers.at(-1)).toMatchObject({ name: 'docs', authentication: 'oauth', scopes: ['docs.read', 'docs.search'], clientId: 'console-client' });
    expect(secrets).toEqual({ docs: 'console-secret' });
  });

  it('changing the client id to another client drops the secret typed for the first one', async () => {
    vi.mocked(saveExtensionLibrary).mockImplementation(async input => ({ library: { ...library, ...input, revision: 6 } as ExtensionLibraryRevision }));
    const view = await section();
    fireEvent.click(within(view).getByRole('button', { name: 'Add server' }));
    const form = screen.getByTestId('extension-server-form');
    fireEvent.change(within(form).getByLabelText(/^Server name/), { target: { value: 'docs' } });
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://tools.example.com/mcp' } });
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'oauth' } });
    const fields = within(form).getByTestId('extension-oauth-fields');
    fireEvent.change(within(fields).getByLabelText(/^Client id/), { target: { value: 'client-a' } });
    fireEvent.change(within(fields).getByLabelText(/^Client secret/), { target: { value: 'secret-for-a' } });
    fireEvent.change(within(fields).getByLabelText(/^Client id/), { target: { value: 'client-b' } });
    expect(within(fields).getByLabelText(/^Client secret/)).toHaveValue('');
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalled());
    const [input, , secrets] = vi.mocked(saveExtensionLibrary).mock.calls[0];
    expect(input.servers.at(-1)).toMatchObject({ name: 'docs', clientId: 'client-b' });
    expect(Object.values(secrets ?? {})).not.toContain('secret-for-a');
  });

  it('switching away from OAuth drops the scopes and client id', async () => {
    vi.mocked(saveExtensionLibrary).mockImplementation(async input => ({ library: { ...library, ...input, revision: 6 } as ExtensionLibraryRevision }));
    const view = await section();
    fireEvent.click(within(view).getByRole('button', { name: 'Add server' }));
    const form = screen.getByTestId('extension-server-form');
    fireEvent.change(within(form).getByLabelText('HTTPS endpoint'), { target: { value: 'https://tools.example.com/mcp' } });
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'oauth' } });
    fireEvent.change(within(form).getByLabelText(/^Client id/), { target: { value: 'console-client' } });
    fireEvent.change(within(form).getByLabelText('Authentication'), { target: { value: 'none' } });
    expect(within(form).queryByTestId('extension-oauth-fields')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(saveExtensionLibrary).toHaveBeenCalled());
    const saved = vi.mocked(saveExtensionLibrary).mock.calls[0][0].servers.at(-1)!;
    expect(saved).not.toHaveProperty('clientId');
    expect(saved).not.toHaveProperty('scopes');
  });
});
