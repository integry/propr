import { useState } from 'react';
import type { PluginManifestView, PluginView } from '../../api/pluginsApi';
import { PluginStep } from './PluginBits';
import { describePluginContributions, formatWhen, packageSecretServers, primaryButtonClass, secretAcknowledgementText } from './pluginUi';

type Acknowledgement = { server: string; package: string; version: string; secretEnv: string[] };

/**
 * A ticked acknowledgement is bound to everything it confirms: server, package, exact version and variable names.
 * When a refreshed read changes any of them the old tick no longer matches, so the box shows unticked again.
 */
const acknowledgementKey = (item: Acknowledgement) => JSON.stringify([item.server, item.package, item.version, item.secretEnv]);

/** The selection for the acknowledgements shown now: whether all are ticked, and the server names to submit. */
function acknowledged(items: Acknowledgement[], checked: string[]) {
  const current = items.filter(item => checked.includes(acknowledgementKey(item)));
  return { ready: current.length === items.length, servers: current.map(item => item.server) };
}

/** One required checkbox per package server whose secret variables reach the task container. */
function SecretAcknowledgements({ items, checked, onChange }: { items: Acknowledgement[]; checked: string[]; onChange: (checked: string[]) => void }) {
  if (!items.length) return null;
  return (
    <fieldset className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <legend className="px-1 font-medium text-amber-900">Secrets inside the task container</legend>
      {items.map(item => {
        const key = acknowledgementKey(item);
        return (
          <div key={key} data-testid="plugin-secret-acknowledgement" className="space-y-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-700">
              <dt className="font-medium">Server</dt><dd className="break-all">{item.server}</dd>
              <dt className="font-medium">Package</dt><dd className="break-all">{item.package}</dd>
              <dt className="font-medium">Exact version</dt><dd className="break-all">{item.version}</dd>
              <dt className="font-medium">Secret variables</dt><dd className="break-all">{item.secretEnv.join(', ')}</dd>
            </dl>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" required checked={checked.includes(key)}
                onChange={event => onChange(event.target.checked ? [...checked, key] : checked.filter(other => other !== key))} />
              <span>{secretAcknowledgementText(item)}</span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

function PermissionList({ permissions }: { permissions: PluginManifestView['permissions'] }) {
  if (!permissions.length) return <p>It asks for no permissions.</p>;
  return (
    <ul aria-label="Permissions" className="space-y-1">
      {permissions.map(permission => (
        <li key={permission.name}><code className="text-xs font-semibold">{permission.name}</code>: {permission.description}</li>
      ))}
    </ul>
  );
}

/** What an upgraded manifest asks for beyond the installed grant, and its Approve action. */
function PendingApproval({ view, manifest, busy, onApprove }: { view: PluginView; manifest: PluginManifestView; busy: boolean; onApprove: (acknowledged: string[]) => void }) {
  const [checked, setChecked] = useState<string[]>([]);
  const permissions = manifest.permissions.filter(permission => view.pendingPermissions.includes(permission.name));
  const { ready, servers } = acknowledged(view.pendingAcknowledgements, checked);
  return (
    <div data-testid="plugin-approval" className="space-y-3 rounded-md border border-amber-300 bg-amber-50/60 p-3">
      <p className="font-medium text-amber-900">Version {manifest.version} needs your approval. Until then the plugin keeps the permissions it was granted.</p>
      {permissions.length > 0 && <><p>It asks for more permissions:</p><PermissionList permissions={permissions} /></>}
      <SecretAcknowledgements items={view.pendingAcknowledgements} checked={checked} onChange={setChecked} />
      <button type="button" className={primaryButtonClass} disabled={busy || !ready} onClick={() => onApprove(servers)}>Approve</button>
    </div>
  );
}

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
      {installation && manifest && view.needsApproval && <PendingApproval view={view} manifest={manifest} busy={busy} onApprove={onApprove} />}
    </PluginStep>
  );
}
