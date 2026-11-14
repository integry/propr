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
    expect(screen.getByRole('checkbox', { name: 'Include draft pull requests' })).toBeChecked();
    expect(screen.getByLabelText('Labels to watch').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Labels to watch')).toHaveValue('bug\ndocs');
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include draft pull requests' }));
    fireEvent.change(screen.getByLabelText('Labels to watch'), { target: { value: ' bug \n\nrelease\n' } });
    const channels = screen.getByRole('group', { name: 'Channel per repository' });
    fireEvent.click(within(channels).getByRole('button', { name: 'Remove repository 2 from Channel per repository' }));
    fireEvent.click(within(channels).getByRole('button', { name: 'Add repository to Channel per repository' }));
    fireEvent.change(within(channels).getByLabelText('Channel per repository: repository 2'), { target: { value: 'acme/docs' } });
    fireEvent.change(within(channels).getByLabelText('Channel per repository: value for repository 2'), { target: { value: '#docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith({
      greeting: null, verbosity: 'quiet', maxItems: 7, includeDrafts: false, labels: ['bug', 'release'], channels: { 'acme/web': '#web', 'acme/docs': '#docs' },
    });
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
    const drafts = { ...draftsOf(EXAMPLE_SETTINGS, {}), maxItems: '1e', channels: [{ repository: 'acme/web', text: 'a' }, { repository: 'acme/web', text: 'b' }] };
    expect(settingsPayload(EXAMPLE_SETTINGS, drafts).maxItems).toBe('1e');
    expect(clientSettingErrors(EXAMPLE_SETTINGS, drafts, false)).toEqual({ maxItems: 'maxItems must be a number', channels: 'channels lists acme/web more than once' });
  });
});
