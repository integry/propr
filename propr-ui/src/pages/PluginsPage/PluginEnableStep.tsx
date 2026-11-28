import { useState } from 'react';
import type { PluginView } from '../../api/pluginsApi';
import { PluginStep } from './PluginBits';

/**
 * Enable: a single checkbox. Unticking disables the plugin and keeps its
 * settings and connections. While something is missing the checkbox cannot be
 * ticked and the step says what is missing.
 */
export function PluginEnableStep({ view, busy, onChange }: { view: PluginView; busy: boolean; onChange: (enabled: boolean) => Promise<unknown> }) {
  // The requested state while the change is in flight; the saved state once the API answers.
  const [requested, setRequested] = useState<boolean | null>(null);
  const installation = view.installation;
  const enabled = Boolean(installation?.enabled);
  const blockers = installation ? view.enableBlockers : ['Install the plugin first'];
  const blocked = !enabled && blockers.length > 0;
  return (
    <PluginStep number={4} title="Enable" done={enabled}>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={requested ?? enabled} disabled={busy || blocked || !installation}
          aria-describedby={blocked ? 'plugin-enable-blockers' : undefined} onChange={event => {
            const next = event.target.checked;
            setRequested(next);
            void onChange(next).finally(() => setRequested(null));
          }} />
        <span>
          <span className="font-medium text-slate-900">Enabled</span>
          <span className="block text-xs text-slate-500">
            {enabled ? 'Untick to disable. Its settings and connections are kept, so ticking it again restores it.' : 'Its MCP servers, skills and templates apply to runs only while enabled.'}
          </span>
        </span>
      </label>
      {blocked && (
        <div id="plugin-enable-blockers" role="status" className="rounded-md bg-amber-50 p-3 text-amber-900">
          <p className="font-medium">It can be enabled once this is done:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
        </div>
      )}
    </PluginStep>
  );
}
