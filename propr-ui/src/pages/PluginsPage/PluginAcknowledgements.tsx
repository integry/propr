import type { PluginManifestView } from '../../api/pluginsApi';
import { acknowledgementKey, type Acknowledgement } from './pluginApprovalUi';
import { secretAcknowledgementText } from './pluginUi';

/** One required checkbox per package server whose secret variables reach the task container. */
export function SecretAcknowledgements({ items, checked, onChange }: { items: Acknowledgement[]; checked: string[]; onChange: (checked: string[]) => void }) {
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

export function PermissionList({ permissions }: { permissions: PluginManifestView['permissions'] }) {
  if (!permissions.length) return <p>It asks for no permissions.</p>;
  return (
    <ul aria-label="Permissions" className="space-y-1">
      {permissions.map(permission => (
        <li key={permission.name}><code className="text-xs font-semibold">{permission.name}</code>: {permission.description}</li>
      ))}
    </ul>
  );
}
