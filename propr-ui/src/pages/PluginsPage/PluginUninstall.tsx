import { useState } from 'react';
import type { PluginView } from '../../api/pluginsApi';
import { buttonClass, dangerButtonClass } from './pluginUi';

/** What an uninstall deletes, from the plugin read: settings, connections, managed items and templates. */
function removedItems(view: PluginView): string[] {
  const items = ['Its settings and repository limit'];
  for (const connection of view.connections) items.push(`Connection ${connection.label}${connection.state === 'connected' ? ' and its stored credential' : ''}`);
  const contributions = view.contributions;
  for (const server of contributions?.mcpServers ?? []) if (server.managed) items.push(`MCP server ${server.managed.name} from Skills & MCP servers`);
  for (const skill of contributions?.skills ?? []) if (skill.managed) items.push(`Skill ${skill.name} from Skills & MCP servers`);
  for (const template of contributions?.automationTemplates ?? []) items.push(`Automation template ${template.catalogId}`);
  return items;
}

/** Uninstall: a separate action with a confirmation listing what is removed; the API's refusal is shown as returned. */
export function PluginUninstall({ view, busy, error, onUninstall }: { view: PluginView; busy: boolean; error: string; onUninstall: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!view.installation) return null;
  return (
    <section aria-labelledby="plugin-uninstall" className="rounded-lg border border-red-200 bg-white p-4 sm:p-5">
      <h2 id="plugin-uninstall" className="text-base font-semibold text-slate-900">Uninstall</h2>
      {!confirming && (
        <div className="mt-3 space-y-2 text-sm text-slate-700">
          <p>To switch the plugin off and keep its settings, untick Enabled instead.</p>
          <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setConfirming(true)}>Uninstall…</button>
        </div>
      )}
      {confirming && (
        <div data-testid="plugin-uninstall-confirm" className="mt-3 space-y-3 text-sm text-slate-700">
          <p className="font-medium text-red-800">Uninstalling {view.manifest?.name ?? view.id} removes:</p>
          <ul className="list-disc space-y-1 pl-5">{removedItems(view).map(item => <li key={item}>{item}</li>)}</ul>
          <p className="text-xs text-slate-600">The audit trail is kept. Installing again starts from the default settings.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={dangerButtonClass} disabled={busy} onClick={onUninstall}>Uninstall {view.manifest?.name ?? view.id}</button>
            <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>Keep it</button>
          </div>
        </div>
      )}
      {error && <p role="alert" data-testid="plugin-uninstall-error" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 [overflow-wrap:anywhere]">{error}</p>}
    </section>
  );
}
