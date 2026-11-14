import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvePlugin, getPlugin, PluginApiError, setPluginSettings, type PluginView } from '../../api/pluginsApi';
import { EXAMPLE_DEFAULTS, exampleAt, renderPluginsPage } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPlugin: vi.fn(), approvePlugin: vi.fn(), setPluginSettings: vi.fn(), setPluginEnabled: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ agents: [], repositories: [{ name: 'acme/web' }] }) }));
vi.mock('../../api/extensionProfilesApi', () => ({
  getExtensionLibrary: vi.fn().mockResolvedValue({ oauth: { redirectUri: 'https://propr.example.com/api/instance/extensions/v1/oauth/callback', clientMetadataUrl: null, connections: {} } }),
}));

const step = (title: string) => screen.getByRole('region', { name: new RegExp(`^\\d\\. ${title}`) });
const badge = () => screen.getAllByTestId('plugin-state')[0];
const open = async (plugin: PluginView) => {
  vi.mocked(getPlugin).mockResolvedValue({ plugin: { ...plugin, audit: [] } });
  renderPluginsPage('/plugins/example-pack');
  await screen.findByRole('heading', { level: 1, name: /Example pack/ });
};
const withSettings = (view: PluginView, settings: Record<string, unknown>, blockers: string[] = view.enableBlockers): PluginView =>
  ({ ...view, installation: { ...view.installation!, settings: settings as never }, enableBlockers: blockers });
const settingError = (key: string) => within(screen.getAllByTestId('plugin-setting').find(element => element.dataset.setting === key)!).queryByTestId('plugin-setting-error');

describe('Plugin settings and approval', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('saves the generated settings form through the API and starts afresh from the values it returned', async () => {
    await open(exampleAt('connected'));
    const configure = step('Configure');
    expect(within(configure).getByLabelText('Greeting')).toHaveValue('hello');
    fireEvent.change(within(configure).getByLabelText('Greeting'), { target: { value: 'hey' } });
    fireEvent.change(within(configure).getByLabelText('Labels to watch'), { target: { value: 'bug' } });
    const next = withSettings(exampleAt('connected'), { ...EXAMPLE_DEFAULTS, greeting: 'hey', labels: ['bug'] });
    vi.mocked(setPluginSettings).mockResolvedValue({ plugin: next });
    await act(async () => { fireEvent.click(within(configure).getByRole('button', { name: 'Save settings' })); });
    expect(setPluginSettings).toHaveBeenCalledWith('example-pack', { ...EXAMPLE_DEFAULTS, greeting: 'hey', labels: ['bug'], channels: null });
    expect(screen.getByText('Settings saved.')).toHaveAttribute('role', 'status');
    expect(within(step('Configure')).getByLabelText('Greeting')).toHaveValue('hey');
  });

  it('shows the API refusal of a setting next to that field, not at the top of the page', async () => {
    await open(exampleAt('connected'));
    vi.mocked(setPluginSettings).mockRejectedValue(new PluginApiError(400, 'greeting is longer than 500 characters'));
    fireEvent.change(within(step('Configure')).getByLabelText('Greeting'), { target: { value: 'x'.repeat(20) } });
    await act(async () => { fireEvent.click(within(step('Configure')).getByRole('button', { name: 'Save settings' })); });
    expect(settingError('greeting')).toHaveTextContent('greeting is longer than 500 characters');
    expect(within(step('Configure')).getByLabelText('Greeting')).toHaveValue('x'.repeat(20));
    expect(screen.queryByText('greeting is longer than 500 characters', { selector: 'p[role="alert"]' })).toBeNull();
  });

  it('blocks the enabled checkbox while a required setting is missing and says which one', async () => {
    const rest = Object.fromEntries(Object.entries(EXAMPLE_DEFAULTS).filter(([key]) => key !== 'verbosity'));
    await open(withSettings(exampleAt('connected'), rest, ['Required setting Verbosity (verbosity) is missing']));
    expect(within(step('Configure')).getByRole('status')).toHaveTextContent('Set Verbosity to enable the plugin.');
    expect(step('Configure')).toHaveAttribute('data-done', 'false');
    const enable = step('Enable');
    expect(within(enable).getByRole('checkbox', { name: /Enabled/ })).toBeDisabled();
    expect(within(enable).getByRole('status')).toHaveTextContent('Required setting Verbosity (verbosity) is missing');
  });

  it('shows new permissions and the changed package details of an upgrade, and approving clears the badge', async () => {
    const upgraded: PluginView = {
      ...exampleAt('enabled'), needsApproval: true, pendingPermissions: ['tasks.read'],
      manifest: { ...exampleAt('enabled').manifest!, version: '0.2.0' },
      pendingAcknowledgements: [{ server: 'example-local', package: 'propr-fixture-mcp-next', version: '2.0.0', secretEnv: ['FIXTURE_TOKEN', 'FIXTURE_SECRET'] }],
    };
    await open(upgraded);
    expect(badge()).toHaveTextContent('Needs approval');
    const approval = screen.getByTestId('plugin-approval');
    expect(approval).toHaveTextContent('Version 0.2.0 needs your approval (approved: 0.1.0)');
    expect(within(approval).getByTestId('plugin-approval-permissions')).toHaveTextContent('tasks.read: Read tasks and their status');
    const changed = within(approval).getByTestId('plugin-approval-package');
    expect(within(changed).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Package changes from propr-fixture-mcp to propr-fixture-mcp-next', 'Version changes from 1.0.0 to 2.0.0', 'Secret variables added: FIXTURE_SECRET',
    ]);
    const approve = within(approval).getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    fireEvent.click(within(approval).getByRole('checkbox', { name: /propr-fixture-mcp-next@2\.0\.0 receives the secret variables FIXTURE_TOKEN, FIXTURE_SECRET/ }));
    vi.mocked(approvePlugin).mockResolvedValue({ plugin: exampleAt('enabled') });
    await act(async () => { fireEvent.click(approve); });
    expect(approvePlugin).toHaveBeenCalledWith('example-pack', ['example-local']);
    expect(badge()).toHaveTextContent('Enabled');
    expect(screen.queryByTestId('plugin-approval')).toBeNull();
    expect(screen.getByText('Approved.')).toHaveAttribute('role', 'status');
  });

  it('lists a package server new in the upgrade, and only permissions when no package changed', async () => {
    const base = exampleAt('connected');
    await open({ ...base, needsApproval: true, installation: { ...base.installation!, acknowledgements: {} },
      pendingAcknowledgements: [{ server: 'example-local', package: 'propr-fixture-mcp', version: '1.0.0', secretEnv: ['FIXTURE_TOKEN'] }] });
    expect(screen.getByTestId('plugin-approval-package')).toHaveTextContent('New package server example-local runs propr-fixture-mcp@1.0.0 with the secret variables FIXTURE_TOKEN');
    expect(screen.queryByTestId('plugin-approval-permissions')).toBeNull();
  });

  it('shows the activity placeholder once installed', async () => {
    await open(exampleAt('installed'));
    expect(screen.getByRole('region', { name: 'Activity' })).toHaveTextContent('No activity yet');
  });
});
