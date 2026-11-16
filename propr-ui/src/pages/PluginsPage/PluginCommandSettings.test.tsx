import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlugin, setPluginCommandWrite, setPluginSharedCommandOwner, type PluginView } from '../../api/pluginsApi';
import { describePluginContributions } from './pluginUi';
import { exampleAt, examplePlugin, renderPluginsPage } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPluginActivity: vi.fn().mockResolvedValue({ health: { state: 'healthy', consecutiveFailures: 0, pauseAfterFailures: 10, lastError: null, lastErrorAt: null, degradedAt: null, pausedAt: null }, deliveries: [] }),
  getPlugin: vi.fn(), setPluginCommandWrite: vi.fn(), setPluginSharedCommandOwner: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ agents: [], repositories: [] }) }));
vi.mock('../../api/extensionProfilesApi', () => ({ getExtensionLibrary: vi.fn().mockResolvedValue({ oauth: null }) }));

type Commands = NonNullable<PluginView['manifest']>['contributes']['commands'];
const COMMANDS: Commands = [
  { name: 'deploy', description: 'Deploy this branch', where: ['pull_request'], kind: 'handler', skills: [], servers: [], needsWrite: false, shared: true, specific: ['example-deploy'] },
  { name: 'example-deploy', description: 'Deploy with the example service', where: ['pull_request'], kind: 'handler', skills: [], servers: [], needsWrite: false, shared: false, specific: [] },
  { name: 'example-release', description: 'Cut a release', where: ['pull_request', 'issue'], kind: 'prompt', skills: [], servers: ['example-api'], needsWrite: true, shared: false, specific: [] },
];
const candidates = [
  { pluginId: 'example-pack', pluginName: 'Example pack', specific: ['example-deploy'], enabled: true },
  { pluginId: 'other-deploy', pluginName: 'Other deploy', specific: ['other-deploy'], enabled: true },
];
/** The example plugin with a shared /deploy and a command that needs write access. */
function withCommands(base: PluginView, settings: { writeAllowed?: boolean; owner?: string | null } = {}): PluginView {
  return {
    ...base,
    manifest: { ...base.manifest!, contributes: { ...base.manifest!.contributes, commands: COMMANDS } },
    commands: [
      { name: 'deploy', needsWrite: false, writeAllowed: false, sharedOwner: { owner: settings.owner ?? null, candidates, ...(settings.owner ? { setBy: '42', setAt: 1_700_000_000_000 } : {}) } },
      { name: 'example-deploy', needsWrite: false, writeAllowed: false },
      { name: 'example-release', needsWrite: true, writeAllowed: settings.writeAllowed ?? false, ...(settings.writeAllowed !== undefined ? { writeChangedBy: '42', writeChangedAt: 1_700_000_000_000 } : {}) },
    ],
  };
}
const open = async (plugin: PluginView) => {
  vi.mocked(getPlugin).mockResolvedValue({ plugin: { ...plugin, audit: [] } });
  renderPluginsPage('/plugins/example-pack');
  await screen.findByRole('heading', { level: 1, name: /Example pack/ });
};
const section = () => screen.getByRole('region', { name: 'Commands' });

describe('Plugin command settings', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('explains at install that a write command stays off until an administrator allows it', async () => {
    const manifest = withCommands(examplePlugin()).manifest!;
    const lines = describePluginContributions(manifest);
    expect(lines).toContain('Adds the /example-release command. It can use write access: off until an administrator switches on "Allow this command to use write access" after installing, and then only for commenters with write permission on the repository');
    expect(lines).toContain('Adds the /deploy command, which calls the plugin\'s handler and starts no task, a name other plugins may offer too (its specific command: /example-deploy)');
    await open(withCommands(examplePlugin()));
    expect(screen.queryByRole('region', { name: 'Commands' })).toBeNull();
    expect(screen.getByRole('list', { name: 'What it adds' })).toHaveTextContent('It can use write access: off until an administrator switches on');
  });

  it('switches write access on for one command, off by default, and shows who changed it', async () => {
    await open(withCommands(exampleAt('enabled')));
    const release = within(section()).getByTestId('plugin-command-settings-example-release');
    const toggle = within(release).getByRole('checkbox', { name: 'Allow this command to use write access' });
    expect(toggle).not.toBeChecked();
    expect(release).toHaveTextContent('that one run can use the plugin\'s servers it names (example-api)');
    expect(release).toHaveTextContent('A retry of the run and later follow-ups get read access only.');
    expect(screen.getByTestId('plugin-command-example-release')).toHaveTextContent('Refused until an administrator allows it write access below');
    expect(within(section()).queryByTestId('plugin-command-write-deploy')).toBeNull();

    vi.mocked(setPluginCommandWrite).mockResolvedValue({ plugin: withCommands(exampleAt('enabled'), { writeAllowed: true }) });
    await act(async () => { fireEvent.click(toggle); });
    expect(setPluginCommandWrite).toHaveBeenCalledWith('example-pack', 'example-release', true);
    expect(within(section()).getByRole('checkbox', { name: 'Allow this command to use write access' })).toBeChecked();
    expect(within(section()).getByTestId('plugin-command-settings-example-release')).toHaveTextContent('Allowed by administrator 42');
    expect(screen.getByTestId('plugin-command-example-release')).toHaveTextContent('Active · write access allowed for commenters with write permission');
    expect(screen.getByText('/example-release can now use write access, for commenters with write permission.')).toHaveAttribute('role', 'status');
  });

  it('chooses which plugin a shared name runs, listing every plugin that offers it', async () => {
    await open(withCommands(exampleAt('enabled')));
    const deploy = within(section()).getByTestId('plugin-command-settings-deploy');
    const select = within(deploy).getByLabelText('Plugin that /deploy runs when several plugins offer it');
    expect(select).toHaveValue('');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Not chosen: the only enabled plugin runs it', 'Example pack', 'Other deploy']);
    expect(deploy).toHaveTextContent('Their specific commands (/example-deploy, /other-deploy) always work.');
    expect(screen.getByTestId('plugin-command-deploy')).toHaveTextContent('shared name, also /example-deploy');

    vi.mocked(setPluginSharedCommandOwner).mockResolvedValue({ plugin: withCommands(exampleAt('enabled'), { owner: 'other-deploy' }) });
    await act(async () => { fireEvent.change(select, { target: { value: 'other-deploy' } }); });
    expect(setPluginSharedCommandOwner).toHaveBeenCalledWith('example-pack', 'deploy', 'other-deploy');
    expect(within(section()).getByLabelText('Plugin that /deploy runs when several plugins offer it')).toHaveValue('other-deploy');
    expect(within(section()).getByTestId('plugin-command-settings-deploy')).toHaveTextContent('Chosen by administrator 42');

    vi.mocked(setPluginSharedCommandOwner).mockResolvedValue({ plugin: withCommands(exampleAt('enabled')) });
    await act(async () => { fireEvent.change(within(section()).getByLabelText('Plugin that /deploy runs when several plugins offer it'), { target: { value: '' } }); });
    expect(setPluginSharedCommandOwner).toHaveBeenLastCalledWith('example-pack', 'deploy', null);
  });
});
