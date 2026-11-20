import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginView } from '../../api/pluginsApi';
import { PluginSettingsForm } from './PluginSettingsForm';
import { exampleAt } from './pluginFixtures.testUtils';

const getPluginSettingOptions = vi.fn();
vi.mock('../../api/pluginsApi', async original => ({ ...(await original<typeof import('../../api/pluginsApi')>()), getPluginSettingOptions: (...args: unknown[]) => getPluginSettingOptions(...args) }));

/** The example plugin with two settings whose choices come from the service, as the Linear plugin declares them. */
function viewWith(settings: Record<string, unknown>): PluginView {
  const view = exampleAt('connected');
  return {
    ...view,
    manifest: {
      ...view.manifest!,
      settings: {
        type: 'object', required: [],
        properties: {
          openedState: { type: 'string', label: 'Move the ticket when the pull request opens to', optionsFrom: 'stateOptions' },
          repositoryTeams: { type: 'object', format: 'repository-map', additionalProperties: { type: 'string' }, label: 'Repository teams', optionsFrom: 'teamOptions' },
        },
      },
    },
    installation: { ...view.installation!, settings: settings as never },
  };
}
const field = (key: string) => screen.getAllByTestId('plugin-setting').find(element => element.dataset.setting === key)!;
const renderForm = (view: PluginView) => {
  const onSave = vi.fn().mockResolvedValue(true);
  render(<PluginSettingsForm view={view} busy={false} apiError="" repositories={['acme/api']} onSave={onSave} />);
  return { onSave };
};

afterEach(() => getPluginSettingOptions.mockReset());

describe('settings with optionsFrom', () => {
  it('loads each setting\'s choices from the plugin and offers them in selects, keeping a saved value the service no longer offers', async () => {
    getPluginSettingOptions.mockImplementation(async (_id: string, setting: string) => (setting === 'openedState'
      ? { options: [{ value: 'In Review', label: 'In Review (ENG)' }, { value: 'Done', label: 'Done (DES, ENG)' }] }
      : { options: [{ value: 'team-eng', label: 'Engineering (ENG)' }, { value: 'team-des', label: 'Design (DES)' }] }));
    const { onSave } = renderForm(viewWith({ openedState: 'Shipped', repositoryTeams: { 'acme/api': 'team-eng' } }));
    expect(getPluginSettingOptions).toHaveBeenCalledWith('example-pack', 'openedState');
    expect(getPluginSettingOptions).toHaveBeenCalledWith('example-pack', 'repositoryTeams');

    const state = await screen.findByRole('combobox', { name: 'Move the ticket when the pull request opens to' });
    expect(within(state).getAllByRole('option').map(o => o.textContent)).toEqual(['Not set', 'In Review (ENG)', 'Done (DES, ENG)', 'Shipped (not offered by the service)']);
    expect(state).toHaveValue('Shipped');
    expect(within(field('openedState')).getByText('2 choices from the service.')).toBeInTheDocument();
    fireEvent.change(state, { target: { value: 'In Review' } });

    const team = await within(field('repositoryTeams')).findByRole('combobox', { name: 'Repository teams: value for repository 1' });
    expect(team).toHaveValue('team-eng');
    fireEvent.change(team, { target: { value: 'team-des' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith({ openedState: 'In Review', repositoryTeams: { 'acme/api': 'team-des' } });
  });

  it('shows the plugin\'s error when the service is not connected, keeps a text box, and reloads on request', async () => {
    getPluginSettingOptions.mockRejectedValue(new Error('Linear is not connected yet. Set the Linear API key under Connections, then choose Reload choices.'));
    renderForm(viewWith({}));
    const alerts = await screen.findAllByTestId('plugin-setting-choices-error');
    expect(alerts).toHaveLength(2);
    expect(within(field('openedState')).getByRole('alert')).toHaveTextContent('Choices could not be loaded: Linear is not connected yet. Set the Linear API key under Connections, then choose Reload choices. You can still type a value.');
    expect(screen.getByLabelText('Move the ticket when the pull request opens to')).toHaveAttribute('type', 'text');

    getPluginSettingOptions.mockResolvedValue({ options: [{ value: 'Done', label: 'Done (ENG)' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Reload choices for Move the ticket when the pull request opens to' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Move the ticket when the pull request opens to' })).toBeInTheDocument());
    expect(within(field('openedState')).queryByRole('alert')).toBeNull();
    expect(within(field('repositoryTeams')).getByRole('alert')).toBeInTheDocument();
  });

  it('asks nothing for settings without optionsFrom', () => {
    render(<PluginSettingsForm view={exampleAt('connected')} busy={false} apiError="" repositories={[]} onSave={vi.fn()} />);
    expect(getPluginSettingOptions).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plugin-setting-choices')).toBeNull();
  });
});
