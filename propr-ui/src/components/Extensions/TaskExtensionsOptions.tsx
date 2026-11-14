import { Puzzle } from 'lucide-react';
import type { TaskExtensionsPreview } from '../../api/taskSubmissions';

interface Props {
  preview?: TaskExtensionsPreview;
  allowWrite: boolean;
  onAllowWriteChange: (value: boolean) => void;
  disableExtensions: boolean;
  onDisableExtensionsChange: (value: boolean) => void;
}

/** Read-only list of the items that apply, the write opt-in and the "Run without extensions" switch. */
export function TaskExtensionsOptions({ preview, allowWrite, onAllowWriteChange, disableExtensions, onDisableExtensionsChange }: Props) {
  if (!preview?.qualified || (!preview.servers.length && !preview.skills.length)) return null;
  const readServers = preview.servers.filter(server => server.capability === 'read');
  const writeServers = preview.servers.filter(server => server.capability === 'write');
  const names = (items: { name: string }[]) => items.map(item => item.name).join(', ');
  return <section aria-label="Extensions" className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 sm:col-span-2">
    <h3 className="flex items-center gap-1.5 font-medium"><Puzzle aria-hidden="true" size={15} />Extensions from the instance library</h3>
    <dl className={`mt-2 space-y-1 text-xs ${disableExtensions ? 'text-slate-400 line-through' : 'text-slate-600'}`} data-testid="task-extensions-applied">
      {readServers.length > 0 && <div><dt className="inline font-medium">MCP servers: </dt><dd className="inline">{names(readServers)}</dd></div>}
      {writeServers.length > 0 && <div><dt className="inline font-medium">Write MCP servers (opt-in): </dt><dd className="inline">{names(writeServers)}</dd></div>}
      {preview.skills.length > 0 && <div><dt className="inline font-medium">Skills: </dt><dd className="inline">{names(preview.skills)}</dd></div>}
    </dl>
    <div className="mt-3 space-y-2">
      <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
        <input type="checkbox" role="switch" checked={disableExtensions} onChange={event => { onDisableExtensionsChange(event.target.checked); if (event.target.checked) onAllowWriteChange(false); }} className="h-4 w-4 rounded border-slate-300" />
        <span>Run without extensions <span className="text-xs text-slate-500">(adds the <code>disable-extensions</code> label)</span></span>
      </label>
      {writeServers.length > 0 && !disableExtensions && <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
        <input type="checkbox" checked={allowWrite} onChange={event => onAllowWriteChange(event.target.checked)} className="h-4 w-4 rounded border-slate-300" />
        <span>Allow write servers for this task’s first run</span>
      </label>}
    </div>
  </section>;
}
