import { useState } from 'react';
import type { PluginManifestView, PluginView } from '../../api/pluginsApi';
import { PermissionList, SecretAcknowledgements } from './PluginAcknowledgements';
import { acknowledged, packageChanges } from './pluginApprovalUi';
import { primaryButtonClass } from './pluginUi';

/**
 * Needs approval: what a newer manifest asks for beyond what was approved — new permissions, and package servers whose
 * package, version or secret variables changed — with the acknowledgement checkbox for secret variables and Approve.
 */
export function PluginApproval({ view, manifest, busy, onApprove }: { view: PluginView; manifest: PluginManifestView; busy: boolean; onApprove: (acknowledged: string[]) => void }) {
  const [checked, setChecked] = useState<string[]>([]);
  const permissions = manifest.permissions.filter(permission => view.pendingPermissions.includes(permission.name));
  const recorded = view.installation?.acknowledgements ?? {};
  const pending = view.pendingAcknowledgements;
  const { ready, servers } = acknowledged(pending, checked);
  return (
    <div data-testid="plugin-approval" className="space-y-3 rounded-md border border-amber-300 bg-amber-50/60 p-3">
      <p className="font-medium text-amber-900">
        Version {manifest.version} needs your approval
        {view.installation && view.installation.installedVersion !== manifest.version ? ` (approved: ${view.installation.installedVersion})` : ''}.
        {' '}Until then the plugin keeps the permissions it was granted.
      </p>
      {permissions.length > 0 && (
        <div data-testid="plugin-approval-permissions" className="space-y-1">
          <p className="font-medium text-slate-900">New permissions it asks for</p>
          <PermissionList permissions={permissions} />
        </div>
      )}
      {pending.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-slate-900">Changed package servers</p>
          <ul aria-label="Changed package servers" className="space-y-2">
            {pending.map(item => (
              <li key={item.server} data-testid="plugin-approval-package" className="break-words">
                <span className="font-medium">{item.server}</span>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {packageChanges(item, Object.prototype.hasOwnProperty.call(recorded, item.server) ? recorded[item.server] : undefined).map(change => <li key={change}>{change}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      <SecretAcknowledgements items={pending} checked={checked} onChange={setChecked} />
      {!ready && <p className="text-xs text-amber-800">Tick the acknowledgement to approve.</p>}
      <button type="button" className={primaryButtonClass} disabled={busy || !ready} onClick={() => onApprove(servers)}>Approve</button>
    </div>
  );
}
