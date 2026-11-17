import { useId, useState } from 'react';
import { usePendingEntry } from './pendingEntries';
import { buttonClass, controlClass, fieldErrorClass, hintClass } from './extensionUi';

/** Lists longer than this get a filter and a scroll box. */
export const PICKER_FILTER_THRESHOLD = 10;

/**
 * A checkbox multi-select, with an optional disclosure for values the list
 * does not offer. Rows have one fixed height and the scroll box of a long list
 * is a whole number of rows tall (eight, plus its border), so no row is cut in half.
 */
export function ExtensionItemPicker({ label, options, selected, onChange, hint, allowManual = false, manualLabel, manualOpen, manualPlaceholder, validate }: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (items: string[]) => void;
  hint?: string;
  allowManual?: boolean;
  /** Show the manual entry open, for items whose values are only ever typed in. */
  manualOpen?: boolean;
  /** Label of the disclosure and field for values the list does not offer; defaults to "Other <label>". */
  manualLabel?: string;
  manualPlaceholder?: string;
  /** Why a typed value cannot be added, or null. */
  validate?: (value: string) => string | null;
}) {
  const filterId = useId();
  const errorId = useId();
  const [manual, setManual] = useState('');
  usePendingEntry(allowManual ? manual : '');
  const [filter, setFilter] = useState('');
  const [unlisted, setUnlisted] = useState(() => selected.filter(item => !options.includes(item)));
  const items = [...new Set([...options, ...unlisted, ...selected])];
  const long = items.length > PICKER_FILTER_THRESHOLD;
  const needle = filter.trim().toLowerCase();
  const shown = long && needle ? items.filter(item => item.toLowerCase().includes(needle)) : items;
  const value = manual.trim();
  const problem = value && validate ? validate(value) : null;
  const add = () => {
    if (!value || problem) return;
    setUnlisted(values => [...new Set([...values, value])]);
    onChange([...new Set([...selected, value])]);
    setManual('');
  };
  const other = manualLabel ?? `Other ${label.toLowerCase()}`;
  return (
    <fieldset className="min-w-0 space-y-2 text-sm">
      <legend className="font-medium text-slate-900">{label}</legend>
      {hint && <p className={hintClass}>{hint}</p>}
      {long && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={filterId} className="sr-only">Filter {label.toLowerCase()}</label>
          <input id={filterId} type="search" className={`${controlClass} max-w-xs`} value={filter} placeholder={`Filter ${items.length}…`}
            onChange={event => setFilter(event.target.value)} />
          {selected.length > 0 && <span className="text-[12px] text-slate-500">{selected.length} selected</span>}
        </div>
      )}
      <div data-testid="extension-item-picker-list"
        className={`rounded border border-slate-200 bg-white ${long ? 'max-h-[calc(16rem+2px)] overflow-y-auto' : ''}`}>
        {items.length === 0 && <p className="flex h-8 items-center px-2.5 text-slate-500">No available items yet.</p>}
        {long && shown.length === 0 && <p className="flex h-8 items-center px-2.5 text-slate-500">No match.</p>}
        {shown.map(item => (
          <label key={item} title={item} className="flex h-8 items-center gap-2 px-2.5 hover:bg-slate-50">
            <input type="checkbox" className="h-4 w-4 shrink-0" checked={selected.includes(item)} onChange={event =>
              onChange(event.target.checked ? [...selected, item] : selected.filter(entry => entry !== item))} />
            <span className="min-w-0 truncate">{item}</span>
          </label>
        ))}
      </div>
      {allowManual && (
        <details open={manualOpen}>
          <summary className="cursor-pointer text-slate-600">{other}</summary>
          <div className="mt-2 flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <input className={controlClass} aria-label={other} value={manual} placeholder={manualPlaceholder} autoCapitalize="none" spellCheck={false}
                aria-invalid={Boolean(problem)} aria-describedby={problem ? errorId : undefined}
                onChange={event => setManual(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
              {problem && <span id={errorId} className={fieldErrorClass}>{problem}</span>}
            </div>
            <button type="button" className={buttonClass} disabled={!value || Boolean(problem)} onClick={add}>Add</button>
          </div>
        </details>
      )}
    </fieldset>
  );
}
