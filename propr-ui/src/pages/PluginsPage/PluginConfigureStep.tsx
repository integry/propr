import { useEffect, useState, type ComponentProps } from 'react';
import type { PluginView } from '../../api/pluginsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { ExtensionItemPicker } from '../SettingsPage/extensions/ExtensionItemPicker';
import { PluginStep } from './PluginBits';
import { PluginSettingsForm } from './PluginSettingsForm';
import { missingRequiredSettings } from './pluginSettingsUi';
import { primaryButtonClass } from './pluginUi';

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every(item => b.includes(item));

/** The repositories this instance manages, offered as limit choices; unlisted names can still be typed. */
function useRepositoryChoices() {
  const [choices, setChoices] = useState<{ repositories: string[]; unavailable: boolean }>({ repositories: [], unavailable: false });
  useEffect(() => {
    let active = true;
    void getInstanceCatalog()
      .then(catalog => { if (active) setChoices({ repositories: catalog.repositories.map(r => r.name), unavailable: false }); })
      .catch(() => { if (active) setChoices({ repositories: [], unavailable: true }); });
    return () => { active = false; };
  }, []);
  return choices;
}

/** Limit to repositories (empty = all). Keyed by the saved limit, so a save starts it afresh. */
function RepositoryLimit({ view, busy, repositories, unavailable, onSave }: {
  view: PluginView; busy: boolean; repositories: string[]; unavailable: boolean; onSave: (repositories: string[]) => Promise<boolean>;
}) {
  const saved = view.installation?.repositories ?? [];
  const [selected, setSelected] = useState<string[]>(saved);
  const changed = !sameList(selected, saved);
  return (
    <div className="space-y-3 border-t border-slate-200 pt-4">
      <p data-testid="plugin-repository-limit">{saved.length ? `Limited to ${saved.join(', ')}.` : 'Applies in all repositories.'}</p>
      {unavailable && <p role="status" className="text-amber-800">Repository choices could not be loaded. Add an unlisted repository instead.</p>}
      <ExtensionItemPicker label="Limit to repositories" options={repositories} selected={selected} onChange={setSelected}
        hint="Optional. Leave all unchecked to apply in every repository." manualLabel="Unlisted repository (owner/name)" allowManual />
      <button type="button" className={primaryButtonClass} disabled={busy || !changed} onClick={() => void onSave(selected)}>Save repositories</button>
    </div>
  );
}

/**
 * Configure: the settings form generated from the manifest, then Limit to repositories. Done once every required
 * setting has a saved value.
 */
export function PluginConfigureStep({ view, busy, settingsError, onSaveSettings, onSaveRepositories }: {
  view: PluginView; busy: boolean;
  /** The API's refusal of the last settings save. */
  settingsError: string;
  onSaveSettings: ComponentProps<typeof PluginSettingsForm>['onSave'];
  onSaveRepositories: (repositories: string[]) => Promise<boolean>;
}) {
  const choices = useRepositoryChoices();
  const { installation, manifest } = view;
  const missing = missingRequiredSettings(view);
  return (
    <PluginStep number={3} title="Configure" done={Boolean(installation) && missing.length === 0}>
      {!installation && <p className="text-slate-500">Install the plugin first.</p>}
      {installation && (
        <>
          {missing.length > 0 && <p role="status" className="text-amber-800">Set {missing.join(', ')} to enable the plugin.</p>}
          {manifest && (
            // Keyed by the schema too: a refreshed manifest can add or retype a setting while the saved values stay the
            // same, and drafts made for the old schema have no field state for it.
            <PluginSettingsForm key={JSON.stringify([manifest.settings, installation.settings])} view={view} busy={busy} apiError={settingsError}
              repositories={choices.repositories} onSave={onSaveSettings} />
          )}
          <RepositoryLimit key={(installation.repositories ?? []).join(',')} view={view} busy={busy} repositories={choices.repositories}
            unavailable={choices.unavailable} onSave={onSaveRepositories} />
        </>
      )}
    </PluginStep>
  );
}
