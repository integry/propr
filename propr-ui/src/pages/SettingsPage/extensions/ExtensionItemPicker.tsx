import { useState } from 'react';
import { buttonClass, inputClass } from './extensionUi';

/** A checkbox multi-select, with an optional advanced field for values the list does not offer. */
export function ExtensionItemPicker({ label, options, selected, onChange, hint, allowManual = false, manualLabel, manualOpen }: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (items: string[]) => void;
  hint?: string;
  allowManual?: boolean;
  /** Show the manual entry open, for items whose values are only ever typed in. */
  manualOpen?: boolean;
  /** Label of the unlisted-value field; defaults to "Unlisted <label>". */
  manualLabel?: string;
}) {
  const [manual, setManual] = useState('');
  const [unlisted, setUnlisted] = useState(() => selected.filter(item => !options.includes(item)));
  const items = [...new Set([...options, ...unlisted, ...selected])];
  const add = () => {
    const value = manual.trim();
    setUnlisted(values => [...new Set([...values, value])]);
    onChange([...new Set([...selected, value])]);
    setManual('');
  };
  return (
    <fieldset className="min-w-0 space-y-2 text-sm">
      <legend className="font-medium">{label}</legend>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-slate-200 bg-white p-3">
        {items.length === 0 && <p className="text-slate-500">No available items yet.</p>}
        {items.map(item => (
          <label key={item} className="flex min-h-8 items-center gap-2 break-all">
            <input type="checkbox" checked={selected.includes(item)} onChange={event =>
              onChange(event.target.checked ? [...selected, item] : selected.filter(value => value !== item))} />
            {item}
          </label>
        ))}
      </div>
      {allowManual && (
        <details open={manualOpen}>
          <summary className="cursor-pointer text-slate-600">Add an unlisted value</summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">{manualLabel ?? `Unlisted ${label.toLowerCase()}`}
              <input className={inputClass} value={manual} onChange={event => setManual(event.target.value)} />
            </label>
            <button type="button" className={buttonClass} disabled={!manual.trim()} onClick={add}>Add</button>
          </div>
        </details>
      )}
    </fieldset>
  );
}
