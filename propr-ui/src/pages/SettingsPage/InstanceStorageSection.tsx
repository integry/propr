import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatabaseExportStatus, RepositoryStorageInventory, StorageCapabilities, StorageCleanupPreview } from '@propr/shared';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';
import * as api from '../../api/instanceStorageApi';
import { SettingsSection } from './SettingsLayout';

const button = 'rounded border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';
const supports = (capabilities: StorageCapabilities | undefined, feature: StorageCapabilities['features'][number]) => capabilities?.features.includes(feature) === true;
const bytes = (n: number | null | undefined) => n == null ? 'Unknown' : `${(n / 1024 ** 2).toFixed(1)} MiB`;

export default function InstanceStorageSection() {
  const user = useCurrentUser();
  if (user?.role !== 'admin' || !userHasPermission(user, 'instance.manage_settings')) return null;
  return <StorageControls key={user.id} actor={user.id} />;
}
function StorageControls({ actor }: { actor: string }) {
  const [capabilities, setCapabilities] = useState<StorageCapabilities>();
  const [inventory, setInventory] = useState<RepositoryStorageInventory>();
  const [preview, setPreview] = useState<StorageCleanupPreview>();
  const [job, setJob] = useState<DatabaseExportStatus>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pollFailures, setPollFailures] = useState(0);
  const alive = useRef(true);
  const capabilitiesRef = useRef<StorageCapabilities | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const clear = useCallback(() => { capabilitiesRef.current = undefined; setCapabilities(undefined); setInventory(undefined); setPreview(undefined); setJob(undefined); setConfirmed(false); }, []);
  const action = useCallback(async (run: () => Promise<void>, onTransient?: () => void) => {
    setBusy(true); setError(''); setMessage('');
    try { await api.verifyStorageActor(actor); if (alive.current) await run(); }
    catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : 'Storage unavailable.');
        // Transient failures keep the known job so an administrator can retry, download or discard it.
        // Authority, account, instance or generation failures clear every authority-bearing result.
        if (e instanceof api.StorageTransientError) onTransient?.();
        else if (e instanceof api.StorageExportGoneError) setJob(undefined);
        else if (e instanceof api.StorageConfirmationError) { setPreview(undefined); setConfirmed(false); }
        else clear();
      }
    }
    finally { if (alive.current) setBusy(false); }
  }, [actor, clear]);
  const refresh = useCallback(() => action(async () => {
    const value = await api.storageCapabilities();
    if (value.version !== 1 || !value.features.includes('repository_inventory')) throw new Error('This runtime does not support instance storage management.');
    // Clear before reading inventory: a later transient failure must not retain a changed instance's job.
    const previous = capabilitiesRef.current;
    if (previous && (previous.instanceId !== value.instanceId || previous.generation !== value.generation)) clear();
    const repositories = await api.storageInventory();
    await api.verifyStorageActor(actor);
    if (repositories.instanceId !== value.instanceId) throw new Error('Instance selection changed.');
    if (alive.current) { capabilitiesRef.current = value; setCapabilities(value); setInventory(repositories); setPreview(undefined); setConfirmed(false); }
  }), [action, actor, clear]);
  useEffect(() => { void refresh(); }, [refresh]); // The keyed component resets all authority on account switch.
  useEffect(() => {
    if (job?.state !== 'running') return;
    // Keep polling through transient failures, backing off up to 30 seconds.
    const timer = setTimeout(() => { void action(async () => {
      const value = await api.databaseExportStatus(job);
      if (value.operationId !== job.operationId || value.instanceId !== job.instanceId || value.generation !== job.generation) throw new Error('Instance selection changed. Refresh before continuing.');
      if (alive.current) { setJob(value); setPollFailures(0); }
    }, () => setPollFailures(count => count + 1)); }, Math.min(30_000, 1000 * 2 ** pollFailures));
    return () => clearTimeout(timer);
  }, [job, action, pollFailures]);
  useEffect(() => {
    if (!job) return;
    // The server refuses an expired job; never keep offering it.
    const timer = setTimeout(() => { setJob(undefined); setMessage('Database export expired. Create a new export if needed.'); }, Math.max(0, Date.parse(job.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [job]);
  const checkInstance = async () => {
    const current = await api.storageCapabilities();
    if (!capabilities || current.instanceId !== capabilities.instanceId || current.generation !== capabilities.generation) throw new Error('Instance selection changed. Refresh before continuing.');
  };
  return <SettingsSection title="Instance data" description="Export this instance’s customer database and safely clean recoverable repository caches. Available to instance administrators on every deployment; no Connect subscription is required.">
    <div className="space-y-5 text-xs">
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div>
        <h5 className="mb-2 font-semibold text-slate-900">Database export</h5>
        <p className="mb-3 max-w-2xl leading-5 text-slate-500">Includes customer records and encrypted customer credentials. Provider homes, agent environment variables, operator credentials and repository files are excluded. This is not a complete configuration backup. Encrypted fields require the original encryption key or reauthentication after import.</p>
        <button className={button} disabled={busy || Boolean(job) || !supports(capabilities, 'database_export')} onClick={() => void action(async () => {
          await checkInstance(); const value = await api.startDatabaseExport(capabilities!); if (alive.current) { setPollFailures(0); setJob(value); }
        })}>Create database export</button>
        {job && <div className="mt-3 space-y-2" role="status">
          <p>Export: {job.state}. Expires {new Date(job.expiresAt).toLocaleTimeString()}.</p>
          {job.state === 'ready' && <>
            <p>{bytes(job.sizeBytes)} · SQLite schema {job.schemaVersion} · {job.migration || 'No migration recorded'}</p>
            <p className="break-all text-slate-500">SHA-256: {job.sha256}</p>
            <button className={button} disabled={busy} onClick={() => void action(async () => {
              await checkInstance(); const blob = await api.downloadDatabaseExport(job);
              await api.verifyStorageActor(actor);
              if (!alive.current) return;
              const url = URL.createObjectURL(blob); const link = document.createElement('a');
              link.href = url; link.download = 'propr-database.sqlite'; link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000); setJob(undefined); setMessage('Database downloaded. This download has been consumed.');
            })}>Download once</button>
          </>}
          {job.state === 'failed' && <p>Export failed; no download is available.</p>}
          <button className={button} disabled={busy} onClick={() => void action(async () => { await api.cancelDatabaseExport(job); if (alive.current) setJob(undefined); })}>Discard export</button>
        </div>}
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between gap-3"><h5 className="font-semibold text-slate-900">Repository inventory</h5><button className={button} disabled={busy} onClick={() => void refresh()}>Refresh inventory</button></div>
        <p className="mb-3 leading-5 text-slate-500">{inventory ? 'Partial inventory: each refresh scans a bounded batch. Unknown sizes are never counted as zero.' : 'Inventory unavailable until the runtime responds.'} Last instance use: {inventory?.lastUseAt ? new Date(inventory.lastUseAt).toLocaleString() : 'Unknown'}.</p>
        {inventory && <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr className="border-b"><th className="py-2">Repository</th><th>Category</th><th>Size</th><th>Protection</th></tr></thead><tbody>
          {inventory.repositories.map(repo => <tr key={repo.id + repo.category} className="border-b border-slate-100"><td className="py-3 pr-4">{repo.name}</td><td className="pr-4">{repo.category.replace(/_/g, ' ')}</td><td className="pr-4">{bytes(repo.estimatedBytes)}</td><td>{repo.protectedReasons.join(', ').replace(/_/g, ' ') || 'Eligible for preview'}</td></tr>)}
        </tbody></table>{inventory.repositories.length === 0 && <p className="py-3 text-slate-500">No registered repository caches in this batch. Unregistered storage is not proven empty.</p>}</div>}
        <button className={`${button} mt-4`} disabled={busy || !supports(capabilities, 'repository_cleanup')} onClick={() => void action(async () => {
          await checkInstance(); const value = await api.storagePreview(capabilities!.instanceId); if (alive.current) { setPreview(value); setConfirmed(false); }
        })}>Preview cache cleanup</button>
      </div>
      {preview && <div role="region" aria-label="Confirm repository cache cleanup" className="border-t border-slate-200 pt-4">
        <h5 className="mb-2 font-semibold">Confirm repository cache cleanup</h5>
        <p className="mb-3 leading-5 text-slate-500">{preview.impact}</p>
        <ul className="mb-3 space-y-2">{preview.candidates.map(candidate => <li key={candidate.id} className="break-all">{candidate.name || inventory?.repositories.find(repo => repo.id === candidate.id)?.name || candidate.id}: {bytes(candidate.estimatedBytes)} — {candidate.protectedReasons.join(', ').replace(/_/g, ' ') || 'Eligible; rechecked before deletion'}</li>)}</ul>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm deletion of only the eligible caches listed in this preview.</label>
        <div className="mt-3 flex gap-3"><button className={button} disabled={busy || !confirmed || !preview.candidates.some(item => !item.protectedReasons.length) || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void action(async () => {
          await checkInstance(); const result = await api.storageExecute(preview); if (alive.current) { setPreview(undefined); setInventory(undefined); setMessage(`Cleanup ${result.state}: ${result.deleted.length} deleted, ${result.retained.length} retained.`); }
        })}>Confirm cleanup</button><button className={button} disabled={busy} onClick={() => { setPreview(undefined); setConfirmed(false); }}>Cancel</button></div>
      </div>}
    </div>
  </SettingsSection>;
}
