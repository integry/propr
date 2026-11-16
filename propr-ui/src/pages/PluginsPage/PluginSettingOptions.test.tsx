import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPluginSettingOptions, PluginApiError, type PluginView } from '../../api/pluginsApi';
import { PluginSettingsForm } from './PluginSettingsForm';
import { EXAMPLE_SETTINGS, exampleAt } from './pluginFixtures.testUtils';

vi.mock('../../api/pluginsApi', async importOriginal => ({ ...(await importOriginal<object>()), getPluginSettingOptions: vi.fn() }));
const options = vi.mocked(getPluginSettingOptions);

/** The example plugin with a team mapping and a state whose choices come from the service (`optionsFrom`), as Linear's do. */
function withChoices(settings: Record<string, unknown> = {}): PluginView {
  const view = exampleAt('connected');
  const manifest = view.manifest!;
  const schema = {
    ...EXAMPLE_SETTINGS,
    properties: {
      team: { type: 'object' as const, format: 'repository-map' as const, additionalProperties: { type: 'string' as const }, optionsFrom: 'teamOptions', label: 'Repository mapping', help: 'Map a repository to a team.' },
      doneState: { type: 'string' as const, maxLength: 100, optionsFrom: 'stateOptions', label: 'Move to state when merged' },
    },
    required: [],
  };
  return { ...view, manifest: { ...manifest, settings: schema as never }, installation: { ...view.installation!, settings: settings as never } };
}
const renderForm = (view: PluginView) => {
  const onSave = vi.fn().mockResolvedValue(true);
  render(<PluginSettingsForm view={view} busy={false} apiError="" repositories={['acme/web']} onSave={onSave} />);
  return { onSave };
};
const field = (key: string) => screen.getAllByTestId('plugin-setting').find(element => element.dataset.setting === key)!;

describe('optionsFrom settings', () => {
  beforeEach(() => options.mockReset());

  it('loads each field\'s choices from the plugin, keeps a saved value the service no longer lists, and saves the chosen one', async () => {
    options.mockImplementation(async (_id, setting) => (setting === 'team'
      ? { options: [{ value: 'team:1', label: 'Team: Engineering (ENG)' }, { value: 'project:9', label: 'Project: Login revamp' }] }
      : { options: [{ value: 'Done', label: 'Done (ENG, OPS)' }, { value: 'In Review', label: 'In Review (ENG)' }] }));
    const { onSave } = renderForm(withChoices({ doneState: 'Shipped', team: { 'acme/web': 'team:1' } }));
    const state = screen.getByLabelText('Move to state when merged');
    await waitFor(() => expect(within(state).getAllByRole('option').map(o => o.textContent)).toEqual(['Not set', 'Shipped (not listed by the service)', 'Done (ENG, OPS)', 'In Review (ENG)']));
    expect(options).toHaveBeenCalledWith('example-pack', 'doneState');
    expect(options).toHaveBeenCalledWith('example-pack', 'team');
    expect(state).toHaveValue('Shipped');
    fireEvent.change(state, { target: { value: 'In Review' } });

    const team = within(field('team')).getByLabelText('Repository mapping: value for repository 1');
    expect(team.tagName).toBe('SELECT');
    await waitFor(() => expect(within(team).getAllByRole('option').map(o => o.textContent)).toEqual(['Not set', 'Team: Engineering (ENG)', 'Project: Login revamp']));
    expect(team).toHaveValue('team:1');
    fireEvent.change(team, { target: { value: 'project:9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith({ team: { 'acme/web': 'project:9' }, doneState: 'In Review' });
  });

  it('shows a clear error when the connection is not made yet, and loads the choices again on request', async () => {
    options.mockRejectedValue(new PluginApiError(409, 'Set the Linear API key under Connections (a personal API key with Read and Write access), then load the choices again.'));
    renderForm(withChoices());
    const alert = await within(field('doneState')).findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the choices: Set the Linear API key under Connections');
    expect(within(field('team')).getByTestId('plugin-setting-options-error')).toHaveTextContent('Set the Linear API key under Connections');
    options.mockResolvedValue({ options: [{ value: 'Done', label: 'Done' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Load the choices of Move to state when merged again' }));
    await waitFor(() => expect(within(screen.getByLabelText('Move to state when merged')).getAllByRole('option').map(o => o.textContent)).toEqual(['Not set', 'Done']));
    expect(within(field('doneState')).queryByRole('alert')).toBeNull();
  });
});
