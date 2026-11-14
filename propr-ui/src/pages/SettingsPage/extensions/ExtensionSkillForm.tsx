import { useId, useState, type FormEvent } from 'react';
import type { ExtensionLibrarySkill, ExtensionSkillBundle } from '@propr/shared';
import { ExtensionItemLimits } from './ExtensionItemLimits';
import { ManagedDefinitionNote } from './ExtensionManagedItem';
import { ExtensionSkillSource, SkillBundleDetails } from './ExtensionSkillImport';
import { NEW_ITEM_LIMITS, buttonClass, primaryButtonClass, type ExtensionChoices, type ItemLimitFields } from './extensionUi';

/**
 * Add or edit one skill: a new skill first picks or imports its bundle, then
 * both set the item limits. Saving writes the library at once.
 */
export function ExtensionSkillForm({ initial, pluginName, bundle: initialBundle, available, choices, onImported, onSave, onCancel }: {
  /** The saved skill being edited; absent for a new one. */
  initial?: ExtensionLibrarySkill;
  /** The managing plugin's display name, for a skill a plugin contributes. */
  pluginName?: string;
  bundle?: ExtensionSkillBundle;
  /** Imported bundles not yet in the library. */
  available: ExtensionSkillBundle[];
  choices: ExtensionChoices;
  onImported: (bundle: ExtensionSkillBundle) => void;
  onSave: (skill: ExtensionLibrarySkill) => Promise<void>;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [bundle, setBundle] = useState(initialBundle);
  const [limits, setLimits] = useState<ItemLimitFields>(() => (initial
    ? { repositories: initial.repositories, agents: initial.agents, autoApply: initial.autoApply } : NEW_ITEM_LIMITS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!bundle) { setError('Choose or import a skill bundle first.'); return; }
    setBusy(true); setError('');
    try { await onSave({ bundleId: bundle.id, enabled: initial?.enabled ?? true, ...limits, ...(initial?.managedBy ? { managedBy: initial.managedBy } : {}) }); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const label = initial ? `Edit skill ${initialBundle?.name ?? initial.bundleId}` : 'Add skill';
  return (
    <form aria-labelledby={titleId} onSubmit={event => void submit(event)} data-testid="extension-skill-form"
      className="space-y-4 rounded-md border border-teal-200 bg-white p-4">
      <h5 id={titleId} className="text-sm font-semibold">{label}</h5>
      {initial?.managedBy && <ManagedDefinitionNote managedBy={initial.managedBy} pluginName={pluginName} />}
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        {bundle ? (
          <div className="rounded-md border border-slate-200 p-3">
            <p className="text-sm font-semibold">{bundle.name}</p>
            <SkillBundleDetails bundle={bundle} />
            {!initial && <button type="button" className={`${buttonClass} mt-2`} onClick={() => setBundle(undefined)}>Choose another bundle</button>}
          </div>
        ) : (
          <ExtensionSkillSource available={available} repositories={choices.repositories} onBusy={setBusy} onError={setError}
            onBundle={next => { onImported(next); setBundle(next); }} />
        )}
        <ExtensionItemLimits item={limits} choices={choices} onChange={patch => setLimits(value => ({ ...value, ...patch }))} />
      </fieldset>
      {error && <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass} disabled={busy || !bundle}>{initial ? 'Save skill' : 'Add skill'}</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
