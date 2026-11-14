import { useEffect, useState } from 'react';
import type { PluginView } from '../../api/pluginsApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { ExtensionItemPicker } from '../SettingsPage/extensions/ExtensionItemPicker';
import { PluginStep } from './PluginBits';
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

/** Configure: in this version only Limit to repositories (empty = all). Keyed by the saved limit, so a save starts it afresh. */
export function PluginConfigureStep({ view, busy, onSave }: { view: PluginView; busy: boolean; onSave: (repositories: string[]) => Promise<boolean> }) {
  const saved = view.installation?.repositories ?? [];
  const [selected, setSelected] = useState<string[]>(saved);
  const choices = useRepositoryChoices();
  const installed = Boolean(view.installation);
  const changed = !sameList(selected, saved);
  return (
    <PluginStep number={3} title="Configure" done={installed}>
      {!installed && <p className="text-slate-500">Install the plugin first.</p>}
      {installed && (
        <>
          <p data-testid="plugin-repository-limit">{saved.length ? `Limited to ${saved.join(', ')}.` : 'Applies in all repositories.'}</p>
          {choices.unavailable && <p role="status" className="text-amber-800">Repository choices could not be loaded. Add an unlisted repository instead.</p>}
          <ExtensionItemPicker label="Limit to repositories" options={choices.repositories} selected={selected} onChange={setSelected}
            hint="Optional. Leave all unchecked to apply in every repository." manualLabel="Unlisted repository (owner/name)" allowManual />
          <button type="button" className={primaryButtonClass} disabled={busy || !changed} onClick={() => void onSave(selected)}>Save repositories</button>
        </>
      )}
    </PluginStep>
  );
}
