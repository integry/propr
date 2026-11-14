import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disconnectPluginOAuth, getPlugin, installPlugin, PluginApiError, setPluginConnection, setPluginEnabled, setPluginRepositories, startPluginOAuth, uninstallPlugin,
  type PluginView,
} from '../../api/pluginsApi';
import { exampleAt, examplePlugin, renderPluginsPage } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPlugin: vi.fn(), installPlugin: vi.fn(), approvePlugin: vi.fn(), setPluginConnection: vi.fn(), setPluginEnabled: vi.fn(),
  setPluginRepositories: vi.fn(), uninstallPlugin: vi.fn(), startPluginOAuth: vi.fn(), disconnectPluginOAuth: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ agents: [], repositories: [{ name: 'acme/web' }, { name: 'acme/api' }] }) }));
vi.mock('../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn().mockResolvedValue({ oauth: { redirectUri: 'https://propr.example.com/api/instance/extensions/v1/oauth/callback', clientMetadataUrl: null, connections: {} } }),
}));

const detail = (plugin: PluginView) => ({ plugin: { ...plugin, audit: [] } });
const step = (title: string) => screen.getByRole('region', { name: new RegExp(`^\\d\\. ${title}`) });
const badge = () => screen.getAllByTestId('plugin-state')[0];
const open = async (plugin: PluginView) => {
  vi.mocked(getPlugin).mockResolvedValue(detail(plugin));
  renderPluginsPage('/plugins/example-pack');
  await screen.findByRole('heading', { level: 1, name: /Example pack/ });
};

describe('Plugin detail', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists what the plugin adds and the permissions it asks for, with the steps in order', async () => {
    await open(examplePlugin());
    expect(screen.getAllByTestId('plugin-step').map(s => s.querySelector('h2')?.textContent)).toEqual(['1. InstallTo do', '2. ConnectTo do', '3. ConfigureTo do', '4. EnableTo do']);
    const install = step('Install');
    expect(within(install).getByRole('list', { name: 'What it adds' })).toHaveTextContent('Runs 1 local server inside the task container');
    expect(within(install).getByRole('list', { name: 'Permissions' })).toHaveTextContent('tasks.read: Read tasks and their status');
    expect(screen.getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', 'https://github.com/integry/propr/tree/main/packages/plugins/example-pack');
    expect(badge()).toHaveTextContent('Not installed');
  });

  it('blocks Install until the secret-variable acknowledgement naming the package, version and variables is ticked', async () => {
    await open(examplePlugin());
    const install = step('Install');
    const button = within(install).getByRole('button', { name: 'Install' });
    expect(button).toBeDisabled();
    const acknowledgement = within(install).getByTestId('plugin-secret-acknowledgement');
    expect(acknowledgement).toHaveTextContent('propr-fixture-mcp');
    expect(acknowledgement).toHaveTextContent('1.0.0');
    const checkbox = within(acknowledgement).getByRole('checkbox', { name: /propr-fixture-mcp@1\.0\.0 receives the secret variable FIXTURE_TOKEN/ });
    vi.mocked(installPlugin).mockResolvedValue({ plugin: exampleAt('installed') });
    fireEvent.click(checkbox);
    expect(button).toBeEnabled();
    await act(async () => { fireEvent.click(button); });
    expect(installPlugin).toHaveBeenCalledWith('example-pack', ['example-local']);
    expect(badge()).toHaveTextContent('Needs connection');
    expect(screen.getByText('Installed. Connect it, then enable it.')).toHaveAttribute('role', 'status');
  });

  it('blocks the enabled checkbox with the reason while a required connection is missing', async () => {
    await open(exampleAt('installed'));
    const enable = step('Enable');
    expect(within(enable).getByRole('checkbox', { name: /Enabled/ })).toBeDisabled();
    expect(within(enable).getByRole('status')).toHaveTextContent('Connection Example API token (example-token) is not set');
  });

  it('stores a write-only token, then enables, disables and limits the plugin', async () => {
    await open(exampleAt('installed'));
    const connect = step('Connect');
    const token = within(connect).getAllByTestId('plugin-connection')[1];
    expect(within(token).getByRole('link', { name: 'How to get it' })).toHaveAttribute('href', 'https://example.com/docs/tokens');
    const field = within(token).getByLabelText('Example API token');
    expect(field).toHaveAttribute('type', 'password');
    vi.mocked(setPluginConnection).mockResolvedValue({ plugin: exampleAt('connected') });
    fireEvent.change(field, { target: { value: 'tok_123' } });
    await act(async () => { fireEvent.click(within(token).getByRole('button', { name: 'Save' })); });
    expect(setPluginConnection).toHaveBeenCalledWith('example-pack', 'example-token', 'tok_123');
    expect(within(step('Connect')).getAllByTestId('plugin-connection')[1]).toHaveTextContent('Stored by administrator 42');
    expect(within(step('Connect')).getByLabelText('Replace Example API token')).toHaveValue('');
    expect(badge()).toHaveTextContent('Off');

    vi.mocked(setPluginRepositories).mockResolvedValue({ plugin: exampleAt('connected', ['acme/web']) });
    fireEvent.click(await within(step('Configure')).findByRole('checkbox', { name: 'acme/web' }));
    await act(async () => { fireEvent.click(within(step('Configure')).getByRole('button', { name: 'Save repositories' })); });
    expect(setPluginRepositories).toHaveBeenCalledWith('example-pack', ['acme/web']);
    expect(screen.getByTestId('plugin-repository-limit')).toHaveTextContent('Limited to acme/web.');

    vi.mocked(setPluginEnabled).mockResolvedValueOnce({ plugin: exampleAt('enabled', ['acme/web']) });
    await act(async () => { fireEvent.click(within(step('Enable')).getByRole('checkbox', { name: /Enabled/ })); });
    expect(setPluginEnabled).toHaveBeenLastCalledWith('example-pack', true);
    expect(badge()).toHaveTextContent('Enabled');
    expect(screen.getByTestId('plugin-contributions')).toHaveTextContent('MCP server example-remote · Active');
    expect(within(screen.getByTestId('plugin-contributions')).getAllByRole('link', { name: 'Skills & MCP servers' })[0]).toHaveAttribute('href', '/settings?tab=agent-extensions');

    vi.mocked(setPluginEnabled).mockResolvedValueOnce({ plugin: exampleAt('connected', ['acme/web']) });
    await act(async () => { fireEvent.click(within(step('Enable')).getByRole('checkbox', { name: /Enabled/ })); });
    expect(setPluginEnabled).toHaveBeenLastCalledWith('example-pack', false);
    expect(badge()).toHaveTextContent('Off');
  });

  it('connects and disconnects an OAuth connection through the shared sign-in component', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    await open(exampleAt('installed'));
    const oauth = within(step('Connect')).getAllByTestId('plugin-connection')[0];
    vi.mocked(startPluginOAuth).mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize?x=1', server: 'example-remote' });
    await act(async () => { fireEvent.click(await within(oauth).findByRole('button', { name: 'Connect' })); });
    expect(startPluginOAuth).toHaveBeenCalledWith('example-pack', 'example-account');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('https://auth.example.com/authorize?x=1');

    vi.mocked(getPlugin).mockResolvedValue(detail(exampleAt('connected')));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    const connected = within(step('Connect')).getAllByTestId('plugin-connection')[0];
    expect(within(connected).getByTestId('extension-oauth-connection')).toHaveAttribute('data-state', 'connected');

    vi.mocked(disconnectPluginOAuth).mockResolvedValue({ plugin: exampleAt('installed') });
    fireEvent.click(within(connected).getByRole('button', { name: 'Disconnect' }));
    await act(async () => { fireEvent.click(within(connected).getByRole('button', { name: 'Confirm disconnect' })); });
    expect(disconnectPluginOAuth).toHaveBeenCalledWith('example-pack', 'example-account');
  });

  it('keeps a confirmed disable when an older background read of the enabled plugin answers later', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ opener: {}, location: { href: '' }, close: vi.fn() } as unknown as Window);
    await open(exampleAt('enabled'));
    vi.mocked(startPluginOAuth).mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize', server: 'example-remote' });
    const oauth = within(step('Connect')).getAllByTestId('plugin-connection')[0];
    await act(async () => { fireEvent.click(await within(oauth).findByRole('button', { name: 'Reconnect' })); });

    let answerRead: (value: ReturnType<typeof detail>) => void = () => {};
    vi.mocked(getPlugin).mockImplementationOnce(() => new Promise(resolve => { answerRead = resolve; }));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(getPlugin).toHaveBeenCalledTimes(2);

    vi.mocked(setPluginEnabled).mockResolvedValueOnce({ plugin: exampleAt('connected') });
    await act(async () => { fireEvent.click(within(step('Enable')).getByRole('checkbox', { name: /Enabled/ })); });
    expect(setPluginEnabled).toHaveBeenLastCalledWith('example-pack', false);
    expect(badge()).toHaveTextContent('Off');

    await act(async () => { answerRead(detail(exampleAt('enabled'))); });
    expect(badge()).toHaveTextContent('Off');
    expect(within(step('Enable')).getByRole('checkbox', { name: /Enabled/ })).not.toBeChecked();
    expect(screen.getByText('Disabled. Its settings and connections are kept.')).toHaveAttribute('role', 'status');
  });

  it('drops a read that answers during a mutation and holds the OAuth controls until the mutation returns', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ opener: {}, location: { href: '' }, close: vi.fn() } as unknown as Window);
    await open(exampleAt('enabled'));
    vi.mocked(startPluginOAuth).mockResolvedValue({ authorizationUrl: 'https://auth.example.com/authorize', server: 'example-remote' });
    const oauth = () => within(step('Connect')).getAllByTestId('plugin-connection')[0];
    await act(async () => { fireEvent.click(await within(oauth()).findByRole('button', { name: 'Reconnect' })); });

    let answerDisable: (value: { plugin: PluginView }) => void = () => {};
    vi.mocked(setPluginEnabled).mockImplementationOnce(() => new Promise(resolve => { answerDisable = resolve; }));
    await act(async () => { fireEvent.click(within(step('Enable')).getByRole('checkbox', { name: /Enabled/ })); });
    expect(within(oauth()).getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(within(oauth()).getByRole('button', { name: 'Reconnect' })).toBeDisabled();

    vi.mocked(getPlugin).mockResolvedValueOnce(detail(exampleAt('enabled')));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { answerDisable({ plugin: exampleAt('connected') }); });
    expect(badge()).toHaveTextContent('Off');
    expect(within(oauth()).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(disconnectPluginOAuth).not.toHaveBeenCalled();
  });

  it('reads the plugin again after a refused action', async () => {
    await open(exampleAt('connected'));
    vi.mocked(getPlugin).mockResolvedValueOnce(detail(exampleAt('enabled')));
    vi.mocked(setPluginEnabled).mockRejectedValueOnce(new PluginApiError(409, 'Already enabled elsewhere'));
    await act(async () => { fireEvent.click(within(step('Enable')).getByRole('checkbox', { name: /Enabled/ })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Already enabled elsewhere');
    expect(getPlugin).toHaveBeenCalledTimes(2);
    expect(badge()).toHaveTextContent('Enabled');
  });

  it('lists what uninstall removes and shows the API refusal text', async () => {
    await open(exampleAt('connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall…' }));
    const confirm = screen.getByTestId('plugin-uninstall-confirm');
    expect(confirm).toHaveTextContent('Connection Example API token and its stored credential');
    expect(confirm).toHaveTextContent('MCP server example-local from Skills & MCP servers');
    expect(confirm).toHaveTextContent('Skill example-notes from Skills & MCP servers');
    expect(confirm).toHaveTextContent('Automation template example-weekly-digest');
    const refusal = 'Automations add items of plugin example-pack explicitly; remove them from "Weekly digest" (example-remote) before uninstalling';
    vi.mocked(uninstallPlugin).mockRejectedValueOnce(new PluginApiError(409, refusal));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Uninstall Example pack' })); });
    expect(screen.getByTestId('plugin-uninstall-error')).toHaveTextContent(refusal);
    expect(badge()).toHaveTextContent('Off');

    vi.mocked(uninstallPlugin).mockResolvedValueOnce({ plugin: examplePlugin() });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Uninstall Example pack' })); });
    expect(uninstallPlugin).toHaveBeenLastCalledWith('example-pack');
    expect(badge()).toHaveTextContent('Not installed');
    expect(within(step('Install')).getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });

  it('shows the error when an action is refused and when the plugin cannot be read', async () => {
    await open(exampleAt('connected'));
    vi.mocked(setPluginEnabled).mockRejectedValue(new PluginApiError(409, 'The plugin cannot be enabled: Required setting Verbosity (verbosity) is missing'));
    await act(async () => { fireEvent.click(within(step('Enable')).getByRole('checkbox', { name: /Enabled/ })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Required setting Verbosity (verbosity) is missing');
  });

  it('shows the read refusal when the plugin cannot be loaded', async () => {
    vi.mocked(getPlugin).mockRejectedValue(new PluginApiError(404, 'Plugin not found'));
    renderPluginsPage('/plugins/missing');
    expect(await screen.findByRole('alert')).toHaveTextContent('Plugin not found');
    expect(screen.getByRole('link', { name: /All plugins/ })).toHaveAttribute('href', '/plugins');
  });

  it('asks for approval of an upgrade before its new acknowledgement is recorded', async () => {
    const installed = exampleAt('connected');
    await open({ ...installed, needsApproval: true, pendingPermissions: ['tasks.read'], pendingAcknowledgements: [{ server: 'example-local', package: 'propr-fixture-mcp', version: '1.1.0', secretEnv: ['FIXTURE_TOKEN'] }] });
    expect(badge()).toHaveTextContent('Needs approval');
    const approval = screen.getByTestId('plugin-approval');
    expect(approval).toHaveTextContent('tasks.read: Read tasks and their status');
    expect(within(approval).getByRole('button', { name: 'Approve' })).toBeDisabled();
    fireEvent.click(within(approval).getByRole('checkbox', { name: /propr-fixture-mcp@1\.1\.0/ }));
    expect(within(approval).getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
});
