import { SettingsStatus, type SettingsStatusTone } from './SettingsLayout';
import type { AgentRuntimePackageRuntimeState } from '../../api/agentRuntimeApi';

function tone(status: AgentRuntimePackageRuntimeState['status']): SettingsStatusTone {
  if (status === 'ready') return 'ok';
  if (status === 'failed') return 'error';
  if (status === 'pending' || status === 'building') return 'warn';
  return 'pending';
}

/**
 * Each runtime in use applies its own list: Docker the last built image, Sprites and Fly Machines the
 * list they accepted after their own package index check. They can differ, e.g. while a change is
 * pending or after one runtime refused it, so each row shows that runtime's state and active list.
 */
export function AgentRuntimePackageRuntimes({ runtimes }: { runtimes?: AgentRuntimePackageRuntimeState[] }) {
  if (!runtimes?.some(runtime => runtime.runtime !== 'docker')) return null;
  return (
    <ul aria-label="Runtime package state per runtime" className="mt-3 divide-y divide-slate-100 rounded border border-slate-200">
      {runtimes.map(runtime => (
        <li key={runtime.runtime} className="px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="text-xs font-medium text-slate-800">{runtime.label}</span>
              <span className="ml-2 text-[11px] text-slate-500">{runtime.source}</span>
            </span>
            <SettingsStatus tone={tone(runtime.status)}>
              {runtime.status}{runtime.activePackages.length > 0 && ` · ${runtime.activePackages.length} active`}
            </SettingsStatus>
          </div>
          {runtime.activePackages.length > 0 && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500" title={runtime.activePackages.join(' ')}>
              {runtime.activePackages.join(' ')}
            </p>
          )}
          {runtime.error && <p className="mt-1 break-words text-[11px] leading-4 text-red-600">{runtime.error}</p>}
          {runtime.warning && !runtime.error && <p className="mt-1 break-words text-[11px] leading-4 text-amber-700">{runtime.warning}</p>}
        </li>
      ))}
    </ul>
  );
}
