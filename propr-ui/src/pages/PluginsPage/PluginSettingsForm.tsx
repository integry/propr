import { useState, type FormEvent } from 'react';
import type { PluginSettingValue } from '@propr/shared';
import type { PluginView } from '../../api/pluginsApi';
import { PluginSettingField } from './PluginSettingFields';
import { primaryButtonClass } from './pluginUi';
import { apiSettingErrors, clientSettingErrors, draftsOf, settingsOf, settingsPayload, type SettingDraft } from './pluginSettingsUi';

/**
 * The settings form ProPR generates from the manifest's settings schema. It is validated here with the API's own rules
 * before saving; a refusal from the API is split into the field it names, next to that field. Fields left as they
 * started save their saved values unchanged. Keyed by the saved settings, so a successful save starts it afresh from
 * what the API returned.
 */
export function PluginSettingsForm({ view, busy, apiError, repositories, onSave }: {
  view: PluginView;
  busy: boolean;
  /** The API's refusal of the last settings save, if any. */
  apiError: string;
  repositories: string[];
  onSave: (settings: Record<string, PluginSettingValue | null>) => Promise<boolean>;
}) {
  const settings = settingsOf(view.manifest!);
  const saved = (view.installation?.settings ?? {}) as Record<string, PluginSettingValue>;
  const enabled = Boolean(view.installation?.enabled);
  const [drafts, setDrafts] = useState(() => draftsOf(settings, saved));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  /** The API refusal shown is the one returned for the values submitted; editing a field hides its part. */
  const [edited, setEdited] = useState<string[]>([]);
  const keys = Object.keys(settings.properties);
  if (!keys.length) return <p data-testid="plugin-settings-none" className="text-slate-500">This plugin has no settings.</p>;
  const api = apiError ? apiSettingErrors(settings, apiError) : { fields: {}, other: [] };
  const errorOf = (key: string) => clientErrors[key] ?? (edited.includes(key) ? undefined : (api.fields as Record<string, string>)[key]);
  const change = (key: string, draft: SettingDraft) => {
    setDrafts(values => ({ ...values, [key]: draft }));
    setEdited(values => (values.includes(key) ? values : [...values, key]));
    setClientErrors(values => Object.fromEntries(Object.entries(values).filter(([other]) => other !== key)));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problems = clientSettingErrors(settings, drafts, enabled, saved);
    setClientErrors(problems);
    if (Object.keys(problems).length) return;
    setEdited([]);
    await onSave(settingsPayload(settings, drafts, saved));
  };
  const invalid = keys.some(key => errorOf(key));
  return (
    <form aria-label="Plugin settings" noValidate data-testid="plugin-settings-form" className="space-y-4" onSubmit={event => void submit(event)}>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="font-medium text-slate-900">Settings</legend>
        {keys.map(key => (
          <div key={key} data-testid="plugin-setting" data-setting={key}>
            <PluginSettingField name={key} setting={settings.properties[key]} draft={drafts[key]} required={settings.required.includes(key)}
              error={errorOf(key)} disabled={busy} repositories={repositories} onChange={draft => change(key, draft)} />
          </div>
        ))}
      </fieldset>
      {invalid && <p role="alert" className="text-sm text-red-800">Correct the highlighted settings, then save again.</p>}
      {api.other.length > 0 && <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-800 [overflow-wrap:anywhere]">{api.other.join('; ')}</p>}
      <button type="submit" className={primaryButtonClass} disabled={busy}>Save settings</button>
    </form>
  );
}
