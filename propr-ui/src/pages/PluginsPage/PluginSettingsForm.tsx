import { useState, type FormEvent } from 'react';
import type { PluginSettingValue } from '@propr/shared';
import type { PluginView } from '../../api/pluginsApi';
import { PluginSettingField } from './PluginSettingFields';
import { primaryButtonClass } from './pluginUi';
import { apiSettingErrors, clientSettingErrors, draftsOf, settingsOf, settingsPayload, type SettingDraft } from './pluginSettingsUi';

/**
 * Number fields holding text the browser cannot read as a number, such as `-` or `1e`. The browser reports such a field's
 * value as empty, the same as a cleared field, so only its `validity.badInput` tells them apart; read at submit, because
 * typing into an already empty field changes no value and fires no change event.
 */
function unreadableNumberProblems(form: HTMLFormElement): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const input of Array.from(form.querySelectorAll<HTMLInputElement>('input[type="number"]'))) {
    const key = input.closest<HTMLElement>('[data-setting]')?.dataset.setting;
    if (key && input.validity.badInput) problems[key] = `${key} must be a number`;
  }
  return problems;
}

/**
 * The settings form ProPR generates from the manifest's settings schema. It is validated here with the API's own rules
 * before saving, and a number field holding text that is not a number is refused rather than saved as removed; a refusal
 * from the API is split into the field it names, next to that field. Fields left as they started save their saved
 * values unchanged. Keyed by the settings schema and the saved settings, so a successful save starts it afresh from
 * what the API returned, and so does a refreshed manifest whose schema changed.
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
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problems = { ...clientSettingErrors(settings, drafts, enabled, saved), ...unreadableNumberProblems(event.currentTarget) };
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
