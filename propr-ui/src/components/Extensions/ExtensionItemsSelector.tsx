import { useEffect, useState } from 'react';
import type { AutomationExtensions, ExtensionLibraryRevision } from '@propr/shared';
import { getExtensionLibrary } from '../../api/extensionProfilesApi';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';

type Choice = { kind: 'servers' | 'skills'; id: string; label: string; detail?: string };

const detailOf = (item: { enabled: boolean; autoApply: boolean }) =>
  !item.enabled ? 'disabled in the library' : item.autoApply ? 'also applies automatically where it matches' : undefined;

/** Library items an automation can add: servers by name, skills by bundle id, plus selected items no longer listed. */
function choicesFor(library: ExtensionLibraryRevision | undefined, value: AutomationExtensions): Choice[] {
  const servers: Choice[] = (library?.servers ?? []).map(s => ({ kind: 'servers', id: s.name, label: s.name, detail: detailOf(s) }));
  const skills: Choice[] = (library?.skills ?? []).map(s => ({
    kind: 'skills', id: s.bundleId, label: library?.skillBundles.find(b => b.id === s.bundleId)?.name ?? s.bundleId, detail: detailOf(s),
  }));
  const missing = (kind: Choice['kind'], ids: string[], listed: Choice[]) =>
    ids.filter(id => !listed.some(c => c.id === id)).map(id => ({ kind, id, label: id, detail: library ? 'not in the library' : undefined }));
  return [...servers, ...missing('servers', value.servers, servers), ...skills, ...missing('skills', value.skills, skills)];
}

/**
 * Extension library items an automation adds explicitly, on top of the items
 * that apply automatically. Choosing them is instance administration, so
 * members see the saved choice read-only and can neither load nor change it.
 */
export function ExtensionItemsSelector({ value, onChange, disabled = false }: { value?: AutomationExtensions | null; onChange: (value: AutomationExtensions) => void; disabled?: boolean }) {
  const user = useCurrentUser(); const permitted = userHasPermission(user, 'instance.manage_settings');
  const [library, setLibrary] = useState<ExtensionLibraryRevision>(); const [error, setError] = useState('');
  useEffect(() => {
    if (!permitted) return;
    let active = true;
    void getExtensionLibrary().then(result => {
      if (active) { setLibrary(result.library); setError(''); }
    }).catch(() => {
      if (active) { setLibrary(undefined); setError('The extension library could not be loaded. Selected items can still be removed.'); }
    });
    return () => { active = false; };
  }, [permitted]);
  const selected = { servers: value?.servers ?? [], skills: value?.skills ?? [] };
  const hasSelection = selected.servers.length > 0 || selected.skills.length > 0;
  const shown = permitted ? library : undefined;
  const choices = choicesFor(shown, selected);
  // An automation without added items needs no controls when nothing can be added.
  if (!hasSelection && (!permitted || choices.length === 0)) return null;
  if (!permitted) {
    return <div className="space-y-1 text-sm">
      <p className="font-medium text-slate-700">Added extensions</p>
      <p className="text-slate-600">{choices.map(c => c.label).join(', ')}</p>
      <p className="text-xs text-slate-500">An instance administrator can change the extensions this automation adds.</p>
    </div>;
  }
  const toggle = (choice: Choice, checked: boolean) => {
    const ids = selected[choice.kind];
    onChange({ ...selected, [choice.kind]: checked ? [...ids, choice.id] : ids.filter(id => id !== choice.id) });
  };
  const group = (kind: Choice['kind'], title: string) => {
    const items = choices.filter(c => c.kind === kind);
    if (!items.length) return null;
    return <fieldset className="space-y-2">
      <legend className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</legend>
      {items.map(choice => <label key={choice.id} className="flex items-start gap-2 break-all">
        <input type="checkbox" className="mt-1" disabled={disabled} checked={selected[kind].includes(choice.id)} onChange={e => toggle(choice, e.target.checked)} />
        <span>{choice.label}{choice.detail && <span className="ml-1 text-xs text-slate-500">({choice.detail})</span>}</span>
      </label>)}
    </fieldset>;
  };
  return <div className="space-y-2 text-sm">
    <p className="font-medium text-slate-700">Added extensions</p>
    <p className="text-xs text-slate-500">These library items are added to this automation’s runs on top of the library items that apply automatically. Claude and Codex runs only; runs keep their existing repository, network and tool restrictions.</p>
    <div role="group" aria-label="Added extensions" className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
      {group('servers', 'MCP servers')}
      {group('skills', 'Skills')}
    </div>
    {error && <p role="status" className="text-xs text-amber-700">{error}</p>}
  </div>;
}
