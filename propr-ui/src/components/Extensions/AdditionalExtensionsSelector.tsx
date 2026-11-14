import { useEffect, useState } from 'react';
import { extensionItemSkipReason, type AutomationExtensions, type ExtensionLibraryRevision, type ExtensionLibraryServer, type ExtensionLibrarySkill, type ExtensionSkipReason } from '@propr/shared';
import { getExtensionLibrary } from '../../api/extensionProfilesApi';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';

type Kind = 'servers' | 'skills';
type Choice = { kind: Kind; id: string; label: string; autoApply: boolean; skipped?: string };

/** The automation's routing: its repositories and the agent alias and type that run it, when known. */
export interface AdditionalExtensionsTarget { repositories: string[]; agentAlias?: string | null; agentType?: string | null }

const SKIP_TEXT: Partial<Record<ExtensionSkipReason, string>> = {
  not_found: 'no longer in the library',
  disabled: 'switched off in the library',
  repository: 'limited to other repositories',
  agent: 'limited to other agents',
  runtime: 'this agent cannot use extensions',
};

/** Why an item would not apply to the automation's runs; write and credential checks happen at launch. */
function skipReason(item: ExtensionLibraryServer | ExtensionLibrarySkill, target: AdditionalExtensionsTarget): string | undefined {
  // An unknown agent or runtime is not held against the item; the run checks again at launch.
  const checked = target.agentAlias ? item : { ...item, agents: [] };
  const reason = extensionItemSkipReason({ servers: [], skills: [] }, checked, {
    repository: target.repositories, agentAlias: target.agentAlias ?? '', runtime: target.agentType ?? 'claude',
  });
  return reason ? SKIP_TEXT[reason] : undefined;
}

type Entry = { id: string; label: string; item: ExtensionLibraryServer | ExtensionLibrarySkill };
/** Items that match the automation, plus selected items that no longer do, each with its skip reason. */
function choicesFor(library: ExtensionLibraryRevision | undefined, value: AutomationExtensions, target: AdditionalExtensionsTarget): Choice[] {
  const build = (kind: Kind, ids: string[], entries: Entry[]): Choice[] => {
    const listed = entries.map(entry => ({ kind, id: entry.id, label: entry.label, autoApply: entry.item.autoApply, skipped: skipReason(entry.item, target) }))
      .filter(choice => !choice.skipped || ids.includes(choice.id));
    const missing = ids.filter(id => !entries.some(entry => entry.id === id))
      .map(id => ({ kind, id, label: id, autoApply: false, skipped: library ? SKIP_TEXT.not_found : undefined }));
    return [...listed, ...missing];
  };
  const bundles = new Map((library?.skillBundles ?? []).map(bundle => [bundle.id, bundle.name]));
  return [
    ...build('servers', value.servers, (library?.servers ?? []).map(item => ({ id: item.name, label: item.name, item }))),
    ...build('skills', value.skills, (library?.skills ?? []).map(item => ({ id: item.bundleId, label: bundles.get(item.bundleId) ?? item.bundleId, item }))),
  ];
}

function useLibrary(permitted: boolean) {
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
  return { library: permitted ? library : undefined, error };
}

function ChoiceGroup({ title, choices, selected, disabled, onToggle }: { title: string; choices: Choice[]; selected: string[]; disabled: boolean; onToggle: (choice: Choice, checked: boolean) => void }) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</legend>
      {choices.length === 0 && <p className="text-xs text-slate-500">None available for this automation’s repositories and agent.</p>}
      {choices.map(choice => (
        <label key={choice.id} className={`flex min-h-8 items-start gap-2 ${choice.skipped ? 'text-slate-500' : ''}`}>
          <input type="checkbox" className="mt-1" disabled={disabled} checked={selected.includes(choice.id)} onChange={event => onToggle(choice, event.target.checked)} />
          <span className="min-w-0">
            <span className="break-all">{choice.label}</span>
            {choice.skipped
              ? <span className="ml-1 text-xs text-amber-700">(skipped: {choice.skipped})</span>
              : choice.autoApply && <span className="ml-1 text-xs text-slate-500">(already applies automatically)</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Additional extensions of an automation: library items its runs add on top
 * of the items that apply automatically. Choosing them is instance
 * administration, so members see the saved choice read-only.
 */
export function AdditionalExtensionsSelector({ value, onChange, target, disabled = false }: {
  value?: AutomationExtensions | null;
  onChange: (value: AutomationExtensions) => void;
  target: AdditionalExtensionsTarget;
  disabled?: boolean;
}) {
  const permitted = userHasPermission(useCurrentUser(), 'instance.manage_settings');
  const { library, error } = useLibrary(permitted);
  const selected = { servers: value?.servers ?? [], skills: value?.skills ?? [] };
  const hasSelection = selected.servers.length > 0 || selected.skills.length > 0;
  const choices = choicesFor(library, selected, target);
  const libraryEmpty = !library?.servers.length && !library?.skills.length;
  // An automation without added items needs no controls when the library is empty.
  if (!hasSelection && (!permitted || libraryEmpty)) return null;
  if (!permitted) {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium text-slate-700">Additional extensions</p>
        <p className="text-slate-600">{choices.map(choice => choice.label).join(', ')}</p>
        <p className="text-xs text-slate-500">An instance administrator can change the extensions this automation adds.</p>
      </div>
    );
  }
  const toggle = (choice: Choice, checked: boolean) => {
    const ids = selected[choice.kind];
    onChange({ ...selected, [choice.kind]: checked ? [...ids, choice.id] : ids.filter(id => id !== choice.id) });
  };
  const group = (kind: Kind, title: string) => (
    <ChoiceGroup title={title} choices={choices.filter(choice => choice.kind === kind)} selected={selected[kind]} disabled={disabled} onToggle={toggle} />
  );
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium text-slate-700">Additional extensions</p>
      <p className="text-xs text-slate-500">
        Library items this automation adds on top of the items that apply automatically, listed when their limits allow the
        automation’s repositories and agent. Items marked “already applies automatically” are used without adding them.
        Claude and Codex runs only.
      </p>
      <div role="group" aria-label="Additional extensions" className="grid gap-3 rounded-md border border-slate-200 bg-white p-3 sm:grid-cols-2">
        {group('servers', 'MCP servers')}
        {group('skills', 'Skills')}
      </div>
      {error && <p role="status" className="text-xs text-amber-700">{error}</p>}
    </div>
  );
}
