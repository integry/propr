import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PluginView } from '../../api/pluginsApi';
import { PluginSettingsForm } from './PluginSettingsForm';
import { EXAMPLE_SETTINGS, exampleAt } from './pluginFixtures.testUtils';
import { apiSettingErrors, clientSettingErrors, draftsOf, settingsPayload } from './pluginSettingsUi';

const saved = { greeting: 'hi there', verbosity: 'detailed', maxItems: 25, includeDrafts: true, labels: ['bug', 'docs'], channels: { 'acme/web': '#web', 'acme/api': '#api' } };
const withSettings = (settings: Record<string, unknown>, enabled = false): PluginView => {
  const view = exampleAt(enabled ? 'enabled' : 'connected');
  return { ...view, installation: { ...view.installation!, settings: settings as never } };
};
const renderForm = (view: PluginView, apiError = '') => {
  const onSave = vi.fn().mockResolvedValue(true);
  const result = render(<PluginSettingsForm view={view} busy={false} apiError={apiError} repositories={['acme/web']} onSave={onSave} />);
  return { onSave, form: screen.getByRole('form', { name: 'Plugin settings' }), ...result };
};
const field = (key: string) => screen.getAllByTestId('plugin-setting').find(element => element.dataset.setting === key)!;
const errorOf = (key: string) => within(field(key)).queryByTestId('plugin-setting-error')?.textContent;

describe('PluginSettingsForm', () => {
  it('generates a field of every settings type from the manifest and shows the saved values', () => {
    renderForm(withSettings(saved));
    expect(screen.getByLabelText('Greeting')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Greeting')).toHaveValue('hi there');
    expect(screen.getByLabelText('Greeting')).toHaveAccessibleDescription(/Text the local example server prefixes to every echo/);
    const verbosity = screen.getByLabelText('Verbosity');
    expect(verbosity.tagName).toBe('SELECT');
    expect(within(verbosity).getAllByRole('option').map(option => option.textContent)).toEqual(['Not set', 'quiet', 'normal', 'detailed']);
    expect(verbosity).toHaveValue('detailed');
    expect(verbosity).toHaveAccessibleDescription(/Required to enable/);
    expect(screen.getByLabelText('Maximum items')).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText('Maximum items')).toHaveValue(25);
    expect(field('maxItems')).toHaveTextContent('A whole number, at least 1, at most 50');
    const drafts = screen.getByLabelText('Include draft pull requests');
    expect(within(drafts).getAllByRole('option').map(option => option.textContent)).toEqual(['Not set', 'Yes', 'No']);
    expect(drafts).toHaveValue('true');
    const labels = screen.getByRole('group', { name: 'Labels to watch' });
    expect(within(labels).getByLabelText('Labels to watch: entry 1')).toHaveValue('bug');
    expect(within(labels).getByLabelText('Labels to watch: entry 2')).toHaveValue('docs');
    const channels = screen.getByRole('group', { name: 'Channel per repository' });
    expect(within(channels).getByLabelText('Channel per repository: repository 1')).toHaveValue('acme/web');
    expect(within(channels).getByLabelText('Channel per repository: value for repository 2')).toHaveValue('#api');
  });

  it('round-trips the values: an unchanged save sends back exactly what was saved', () => {
    const { onSave } = renderForm(withSettings(saved));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith(saved);
  });

  it('saves edited values of each type and removes cleared ones with null', () => {
    const { onSave } = renderForm(withSettings(saved));
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Verbosity'), { target: { value: 'quiet' } });
    fireEvent.change(screen.getByLabelText('Maximum items'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Include draft pull requests'), { target: { value: 'false' } });
    const labels = screen.getByRole('group', { name: 'Labels to watch' });
    fireEvent.change(within(labels).getByLabelText('Labels to watch: entry 2'), { target: { value: ' release\nnotes ' } });
    fireEvent.click(within(labels).getByRole('button', { name: 'Add entry to Labels to watch' }));
    const channels = screen.getByRole('group', { name: 'Channel per repository' });
    fireEvent.click(within(channels).getByRole('button', { name: 'Remove repository 2 from Channel per repository' }));
    fireEvent.click(within(channels).getByRole('button', { name: 'Add repository to Channel per repository' }));
    fireEvent.change(within(channels).getByLabelText('Channel per repository: repository 2'), { target: { value: 'acme/docs' } });
    fireEvent.change(within(channels).getByLabelText('Channel per repository: value for repository 2'), { target: { value: '#docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith({
      greeting: null, verbosity: 'quiet', maxItems: 7, includeDrafts: false, labels: ['bug', ' release\nnotes ', ''], channels: { 'acme/web': '#web', 'acme/docs': '#docs' },
    });
  });

  it('saves list entries with spaces, empty entries and line breaks, and empty collections, unchanged when another setting is edited', () => {
    const exact = { ...saved, labels: [' bug ', '', 'first\nsecond'], channels: {} };
    const unchanged = renderForm(withSettings(exact, true));
    expect(within(screen.getByRole('group', { name: 'Labels to watch' })).getByLabelText('Labels to watch: entry 3')).toHaveValue('first\nsecond');
    expect(within(screen.getByRole('group', { name: 'Channel per repository' })).getByTestId('plugin-setting-state')).toHaveTextContent('No repositories yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(unchanged.onSave).toHaveBeenCalledWith(exact);
    unchanged.unmount();

    const edited = renderForm(withSettings({ ...exact, labels: [] }, true));
    expect(within(screen.getByRole('group', { name: 'Labels to watch' })).getByTestId('plugin-setting-state')).toHaveTextContent('Empty list.');
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(edited.onSave).toHaveBeenCalledWith({ ...exact, labels: [], greeting: 'changed' });
  });

  it('keeps an empty list after its last entry is removed and removes the setting only when cleared', () => {
    const { onSave } = renderForm(withSettings({ ...saved, labels: ['bug'] }));
    const labels = screen.getByRole('group', { name: 'Labels to watch' });
    fireEvent.click(within(labels).getByRole('button', { name: 'Remove entry 1 from Labels to watch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenLastCalledWith({ ...saved, labels: [] });
    fireEvent.click(within(labels).getByRole('button', { name: 'Clear Labels to watch' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Channel per repository' })).getByRole('button', { name: 'Clear Channel per repository' }));
    expect(within(labels).getByTestId('plugin-setting-state')).toHaveTextContent('Not set.');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenLastCalledWith({ ...saved, labels: null, channels: null });
  });

  it('leaves unset settings unset on an unchanged save', () => {
    const { onSave } = renderForm(withSettings({ verbosity: 'normal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith({ greeting: null, verbosity: 'normal', maxItems: null, includeDrafts: null, labels: null, channels: null });
  });

  it('saves an explicit false for a previously unset required true/false setting, so it no longer blocks enabling', () => {
    const settings = { ...EXAMPLE_SETTINGS, required: ['verbosity', 'includeDrafts'] };
    const view = withSettings({ verbosity: 'normal' });
    const onSave = vi.fn().mockResolvedValue(true);
    render(<PluginSettingsForm view={{ ...view, manifest: { ...view.manifest!, settings: settings as never } }} busy={false} apiError="" repositories={[]} onSave={onSave} />);
    const drafts = screen.getByLabelText('Include draft pull requests');
    expect(drafts).toHaveValue('');
    fireEvent.change(drafts, { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith({ greeting: null, verbosity: 'normal', maxItems: null, includeDrafts: false, labels: null, channels: null });
  });

  it('keeps a saved false unchanged and removes a saved true/false setting when it is set back to Not set', () => {
    const { onSave } = renderForm(withSettings({ ...saved, includeDrafts: false }));
    expect(screen.getByLabelText('Include draft pull requests')).toHaveValue('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenLastCalledWith({ ...saved, includeDrafts: false });
    fireEvent.change(screen.getByLabelText('Include draft pull requests'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenLastCalledWith({ ...saved, includeDrafts: null });
  });

  it('validates before saving and shows each problem next to its field', () => {
    const { onSave } = renderForm(withSettings(saved));
    fireEvent.change(screen.getByLabelText('Maximum items'), { target: { value: '99' } });
    const channels = screen.getByRole('group', { name: 'Channel per repository' });
    fireEvent.change(within(channels).getByLabelText('Channel per repository: repository 1'), { target: { value: 'not a repository' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(errorOf('maxItems')).toBe('maxItems must be at most 50');
    expect(screen.getByLabelText('Maximum items')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Maximum items')).toHaveAccessibleDescription(/maxItems must be at most 50/);
    expect(errorOf('channels')).toBe('channels must map owner/repo to text');
    expect(errorOf('greeting')).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent('Correct the highlighted settings');
    // Editing the field clears its error.
    fireEvent.change(screen.getByLabelText('Maximum items'), { target: { value: '5' } });
    expect(errorOf('maxItems')).toBeUndefined();
  });

  it('accepts an unchanged save of a required empty collection while the plugin is enabled', () => {
    const settings = { ...EXAMPLE_SETTINGS, required: ['verbosity', 'labels'] };
    const drafts = draftsOf(settings, { ...saved, labels: [] });
    expect(clientSettingErrors(settings, drafts, true, { ...saved, labels: [] })).toEqual({});
    expect(settingsPayload(settings, drafts, { ...saved, labels: [] }).labels).toEqual([]);
  });

  it('refuses to remove a required setting while the plugin is enabled', () => {
    const { onSave } = renderForm(withSettings(saved, true));
    fireEvent.change(screen.getByLabelText('Verbosity'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(errorOf('verbosity')).toBe('verbosity is required while the plugin is enabled');
  });

  it('shows the field errors the API returned next to their fields and the rest above the button', () => {
    renderForm(withSettings(saved), 'maxItems must be a whole number; greeting is longer than 500 characters; Settings must be an object');
    expect(errorOf('maxItems')).toBe('maxItems must be a whole number');
    expect(errorOf('greeting')).toBe('greeting is longer than 500 characters');
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual(['Correct the highlighted settings, then save again.', 'Settings must be an object']);
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'short' } });
    expect(errorOf('greeting')).toBeUndefined();
    expect(errorOf('maxItems')).toBe('maxItems must be a whole number');
  });

  it('refuses a number field holding text that is not a number instead of removing the saved value', () => {
    const { onSave } = renderForm(withSettings(saved));
    const maxItems = screen.getByLabelText('Maximum items') as HTMLInputElement;
    // A browser reports `1e` in a number field as an empty value; only validity.badInput tells it from a cleared field.
    fireEvent.change(maxItems, { target: { value: '' } });
    Object.defineProperty(maxItems, 'validity', { configurable: true, value: { ...maxItems.validity, badInput: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(errorOf('maxItems')).toBe('maxItems must be a number');
    expect(onSave).not.toHaveBeenCalled();

    // Emptied on purpose, the field removes the setting.
    Object.defineProperty(maxItems, 'validity', { configurable: true, value: { ...maxItems.validity, badInput: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith({ ...saved, maxItems: null });
  });

  it('says so when the plugin has no settings', () => {
    const view = withSettings({});
    render(<PluginSettingsForm view={{ ...view, manifest: { ...view.manifest!, settings: { type: 'object', properties: {}, required: [] } } }} busy={false} apiError="" repositories={[]} onSave={vi.fn()} />);
    expect(screen.getByTestId('plugin-settings-none')).toHaveTextContent('This plugin has no settings.');
  });
});

describe('plugin settings helpers', () => {
  it('maps the API refusal to required keys it names', () => {
    expect(apiSettingErrors(EXAMPLE_SETTINGS, 'Required settings cannot be removed while the plugin is enabled: verbosity'))
      .toEqual({ fields: { verbosity: 'verbosity is required while the plugin is enabled' }, other: [] });
    expect(apiSettingErrors(EXAMPLE_SETTINGS, 'unknown is not a setting of this plugin')).toEqual({ fields: {}, other: ['unknown is not a setting of this plugin'] });
  });

  it('keeps a number that does not parse so validation names it, and finds a repository listed twice', () => {
    const drafts = { ...draftsOf(EXAMPLE_SETTINGS, {}), maxItems: '1e', channels: { set: true, rows: [{ repository: 'acme/web', text: 'a' }, { repository: 'acme/web', text: 'b' }] } };
    expect(settingsPayload(EXAMPLE_SETTINGS, drafts).maxItems).toBe('1e');
    expect(clientSettingErrors(EXAMPLE_SETTINGS, drafts, false)).toEqual({ maxItems: 'maxItems must be a number', channels: 'channels lists acme/web more than once' });
  });
});
