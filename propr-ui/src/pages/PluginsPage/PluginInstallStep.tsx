import { useState } from 'react';
import type { PluginView } from '../../api/pluginsApi';
import { PermissionList, SecretAcknowledgements } from './PluginAcknowledgements';
import { acknowledged, type Acknowledgement } from './pluginApprovalUi';
import { PluginApproval } from './PluginApproval';
import { PluginStep } from './PluginBits';
import { describePluginContributions, formatWhen, packageSecretServers, primaryButtonClass } from './pluginUi';

/**
 * Install: what the plugin adds in plain words, the permissions it asks for
 * and, for package servers with secret variables, the required acknowledgement.
 */
export function PluginInstallStep({ view, busy, onInstall, onApprove }: {
  view: PluginView; busy: boolean;
  onInstall: (acknowledged: string[]) => void;
  onApprove: (acknowledged: string[]) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const { manifest, installation } = view;
  const secrets: Acknowledgement[] = manifest ? packageSecretServers(manifest).map(server => ({ server: server.name, package: server.package, version: server.version, secretEnv: server.secretEnv.map(s => s.name) })) : [];
  const { ready, servers } = acknowledged(secrets, checked);
  return (
    <PluginStep number={1} title="Install" done={Boolean(installation) && !view.needsApproval}>
      {manifest && (
        <>
          <p className="font-medium text-slate-900">What it adds</p>
          <ul aria-label="What it adds" className="list-disc space-y-1 pl-5">
            {describePluginContributions(manifest).map(line => <li key={line}>{line}</li>)}
          </ul>
          <p className="font-medium text-slate-900">Permissions it asks for</p>
          <PermissionList permissions={manifest.permissions} />
        </>
      )}
      {installation ? (
        <p className="text-slate-600">Version {installation.installedVersion} installed by administrator {installation.installedBy} · {formatWhen(installation.installedAt)}</p>
      ) : manifest && (
        <>
          <SecretAcknowledgements items={secrets} checked={checked} onChange={setChecked} />
          {!ready && <p className="text-xs text-amber-800">Tick the acknowledgement to install.</p>}
          <button type="button" className={primaryButtonClass} disabled={busy || !ready} onClick={() => onInstall(servers)}>Install</button>
        </>
      )}
      {installation && manifest && view.needsApproval && <PluginApproval view={view} manifest={manifest} busy={busy} onApprove={onApprove} />}
    </PluginStep>
  );
}
