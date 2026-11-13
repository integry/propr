import { useState, type ReactNode } from 'react';
import { appliesTo, buttonClass, dangerButtonClass, type ItemLimitFields } from './extensionUi';

export interface ExtensionItemNote { tone: 'info' | 'warning'; text: ReactNode }

const badge = 'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide';

/**
 * One library item. The enabled checkbox saves at once through the
 * single-item endpoint; a switched-off row stays, dimmed, with its settings.
 * Removing asks for confirmation first.
 */
export function ExtensionItemRow({ name, kind, capability, item, enabled, pending, busy, notes, onToggle, onEdit, onRemove, testId, children }: {
  name: string;
  kind: string;
  capability?: 'read' | 'write';
  item: ItemLimitFields;
  /** Shown state: the requested state while a toggle is in flight. */
  enabled: boolean;
  pending: boolean;
  busy: boolean;
  notes: ExtensionItemNote[];
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  testId: string;
  /** Item-specific state and actions shown under the notes, such as an OAuth connection. */
  children?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li data-testid={testId} data-enabled={enabled ? 'true' : 'false'}
      className={`rounded-md border p-3 text-sm ${enabled ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" aria-label={`Enabled: ${name}`} checked={enabled} disabled={pending}
          onChange={event => onToggle(event.target.checked)} />
        <div className={`min-w-0 flex-1 ${enabled ? '' : 'opacity-60'}`}>
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-all font-semibold text-slate-900">{name}</span>
            {!enabled && <span className={`${badge} bg-slate-200 text-slate-700`}>Off</span>}
            <span className="text-xs text-slate-500">{kind}</span>
            {capability && <span className={`${badge} ${capability === 'write' ? 'bg-amber-100 text-amber-900' : 'bg-teal-50 text-teal-800'}`}>{capability === 'write' ? 'Write' : 'Read'}</span>}
            {pending && <span className="text-xs text-slate-500">Saving…</span>}
          </p>
          <p className="mt-1 break-words text-xs text-slate-600">
            {appliesTo(item)} · {item.autoApply ? 'Applies automatically' : 'Only where an automation adds it'}
            {item.agents.length > 0 && <> · Agents: {item.agents.join(', ')}</>}
          </p>
        </div>
      </div>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-1 pl-7 text-xs">
          {notes.map((note, index) => (
            <li key={index} className={note.tone === 'warning' ? 'text-amber-800' : 'text-slate-600'}>{note.text}</li>
          ))}
        </ul>
      )}
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
        {confirming ? (
          <>
            <span className="text-xs text-red-800">Remove {name} from the library? Its settings and stored secret are deleted.</span>
            <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => { setConfirming(false); onRemove(); }}>Confirm removal</button>
            <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <>
            <button type="button" className={buttonClass} disabled={busy} onClick={onEdit}>Edit</button>
            <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setConfirming(true)}>Remove</button>
          </>
        )}
      </div>
    </li>
  );
}
