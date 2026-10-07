import React, { useEffect, useState } from 'react';
import { getSettings, type MonitoredRepo } from '../api/proprApi';

type AutoResolveChoice = 'inherit' | 'always' | 'never';

const toChoice = (value: boolean | null | undefined): AutoResolveChoice =>
  value === true ? 'always' : value === false ? 'never' : 'inherit';

const fromChoice = (choice: AutoResolveChoice): boolean | null =>
  choice === 'always' ? true : choice === 'never' ? false : null;

/** Instance `auto_resolve_merge_conflicts` default; undefined while unknown. */
function useInstanceAutoResolveDefault(): boolean | undefined {
  const [instanceDefault, setInstanceDefault] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then(settings => {
        if (!cancelled && typeof settings.auto_resolve_merge_conflicts === 'boolean') setInstanceDefault(settings.auto_resolve_merge_conflicts);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return instanceDefault;
}

export const RepositoryAutoResolveConflictsControl: React.FC<{
  repo: MonitoredRepo;
  onUpdate: (repoId: string, value: boolean | null) => void;
  isReadOnly: boolean;
  /** Supplied by callers that already know it; otherwise loaded from settings. */
  instanceDefault?: boolean;
}> = ({ repo, onUpdate, isReadOnly, instanceDefault }) => {
  const loadedDefault = useInstanceAutoResolveDefault();
  const effectiveDefault = instanceDefault ?? loadedDefault;
  const inheritLabel = effectiveDefault === undefined
    ? 'Use instance default'
    : `Use instance default (currently ${effectiveDefault ? 'On' : 'Off'})`;

  return (
    <label className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600">
      <span className="min-w-0">
        <span className="block">Auto-resolve merge conflicts</span>
        <span className="mt-1 block text-slate-500">When a ProPR pull request conflicts with its base branch, merge the base and let an agent resolve the conflicts. Applies to every branch of this repository.</span>
      </span>
      <select
        aria-label={`Auto-resolve merge conflicts for ${repo.name}`}
        value={toChoice(repo.autoResolveMergeConflicts)}
        disabled={isReadOnly}
        onChange={event => {
          if (isReadOnly) return;
          onUpdate(repo.id, fromChoice(event.target.value as AutoResolveChoice));
        }}
        className="shrink-0 rounded border border-slate-200 bg-white px-2 py-1 text-slate-700 focus:border-teal-400"
      >
        <option value="inherit">{inheritLabel}</option>
        <option value="always">Always</option>
        <option value="never">Never</option>
      </select>
    </label>
  );
};
