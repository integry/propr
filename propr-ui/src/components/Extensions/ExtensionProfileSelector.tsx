import { useEffect, useState } from 'react';
import type { ExtensionProfileRevision, ExtensionSelection } from '@propr/shared';
import { listExtensionProfiles } from '../../api/extensionProfilesApi';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';
export function ExtensionProfileSelector({ value, onChange, disabled = false }: { value?: ExtensionSelection | null; onChange: (value: ExtensionSelection | null) => void; disabled?: boolean }) {
  const user = useCurrentUser(); const permitted = userHasPermission(user, 'instance.manage_settings');
  const [profiles, setProfiles] = useState<ExtensionProfileRevision[]>([]); const [error, setError] = useState('');
  useEffect(() => {
    if (!permitted) return;
    let active = true;
    void listExtensionProfiles().then(result => {
      if (active) { setProfiles(result.profiles.filter(p => p.enabled)); setError(''); }
    }).catch(() => {
      if (active) { setProfiles([]); setError('Extension profiles could not be loaded. Select None to clear this selection.'); }
    });
    return () => { active = false; };
  }, [permitted]);
  // A task with no selected profile needs no extension controls. An empty
  // catalog (or an unavailable optional endpoint) is not a task error.
  if (!value && (!permitted || profiles.length === 0)) return null;
  const selected = permitted ? profiles.find(p => p.profileId === value?.profileId && p.revision === value.revision) : undefined;
  return <div className="space-y-2 text-sm">
    <label className="block font-medium text-slate-700">Agent extension profile
      <select aria-label="Agent extension profile" disabled={disabled} value={selected?.profileId ?? (value ? 'unavailable' : '')} onChange={event => {
        const profile = permitted ? profiles.find(p => p.profileId === event.target.value) : undefined;
        onChange(profile ? { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision } : null);
      }} className="mt-2 block w-full rounded-md border border-slate-300 bg-white p-2">
        <option value="">None</option>
        {value && !selected && <option value="unavailable" disabled>{permitted ? 'Selected revision unavailable — clear selection or select a current profile' : 'Selected revision unavailable — choose None to clear'}</option>}
        {permitted && profiles.map(p => <option key={p.profileId} value={p.profileId}>{p.name} · revision {p.revision}</option>)}
      </select>
    </label>
    <p className="text-xs text-slate-500">Claude and Codex task runs only. Profiles keep the run’s existing repository, network and tool restrictions.</p>
    {error && <p role="status" className="text-xs text-amber-700">{error}</p>}
  </div>;
}
