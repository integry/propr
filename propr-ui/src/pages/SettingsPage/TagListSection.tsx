import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { SettingsSection } from './SettingsLayout';
import { SETTINGS_FIELD, SETTINGS_HELPER, SETTINGS_LABEL } from './settingsStyles';
import { duplicateTagIn, parseTagDraft } from './tagDraft';

interface TagListSectionProps {
  title: string;
  description: string;
  items: string[];
  newItem: string;
  placeholder: string;
  emptyMessage: string;
  helperText?: string;
  /** Label for the entry input. Defaults to a generic "Add an entry". */
  addLabel?: string;
  onNewItemChange: (value: string) => void;
  /** Commits entries as one list update. Blank and duplicate entries are ignored. */
  onAddItems: (values: string[]) => void;
  onRemoveItem: (item: string) => void;
  /** The list never drops below this many entries; their remove buttons are disabled. */
  minItems?: number;
  className?: string;
}

/**
 * A tag input: committed entries sit as monospace chips inside the same
 * container as the text field. Enter or a comma turns the typed text into a
 * chip, and a pasted comma-separated list becomes one chip per entry.
 * Backspace on an empty field first selects the last chip and only a second
 * Backspace removes it; auto-repeat from a held key does neither. Leaving the field saves nothing: the typed text stays
 * in the field until Enter or a comma.
 */
const TagListSection: React.FC<TagListSectionProps> = ({
  title,
  description,
  items,
  newItem,
  placeholder,
  emptyMessage,
  helperText,
  addLabel = 'Add an entry',
  onNewItemChange,
  onAddItems,
  onRemoveItem,
  minItems = 0,
  className
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `tag-list-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const helperId = `${inputId}-helper`;
  const [removalArmed, setRemovalArmed] = useState(false);
  const duplicate = duplicateTagIn(newItem, items);
  const canRemove = items.length > minItems;
  const lastItem = items[items.length - 1];

  const commit = (text: string, final: boolean): void => {
    const { added, draft } = parseTagDraft(text, items, final);
    if (added.length > 0) onAddItems(added);
    onNewItemChange(draft);
  };

  const handleChange = (value: string): void => {
    setRemovalArmed(false);
    // Only a newly typed or pasted comma ends an entry; deleting text never does.
    const commaCount = (text: string) => text.split(',').length;
    if (commaCount(value) > commaCount(newItem)) commit(value, false);
    else onNewItemChange(value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(newItem, true);
    } else if (event.key === 'Backspace' && newItem === '' && canRemove) {
      event.preventDefault();
      // A held Backspace that has just emptied the draft must not go on to
      // arm and remove saved entries: each step takes a fresh press.
      if (event.repeat) return;
      if (removalArmed) {
        setRemovalArmed(false);
        onRemoveItem(lastItem);
      } else {
        setRemovalArmed(true);
      }
    } else {
      setRemovalArmed(false);
    }
  };

  return (
    <SettingsSection title={title} description={description} className={className}>
      <div className={SETTINGS_FIELD}>
        <label className={SETTINGS_LABEL} htmlFor={inputId}>{addLabel}</label>
        <div
          data-tag-input
          onClick={() => inputRef.current?.focus()}
          className="mt-1.5 flex min-h-[34px] w-full cursor-text flex-wrap items-center gap-1.5 rounded border border-slate-300 bg-white px-2 py-1 shadow-sm focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500"
        >
          {items.map(item => (
            <span
              key={item}
              data-removal-armed={removalArmed && item === lastItem ? '' : undefined}
              className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px] font-medium ${
                removalArmed && item === lastItem
                  ? 'bg-slate-700 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >
              {item}
              <button
                type="button"
                disabled={!canRemove}
                title={canRemove ? undefined : `At least ${minItems === 1 ? 'one entry is' : `${minItems} entries are`} required`}
                onClick={(event) => { event.stopPropagation(); setRemovalArmed(false); onRemoveItem(item); }}
                className="ml-1.5 inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-300 hover:text-slate-700 focus:bg-slate-400 focus:text-white focus:outline-none disabled:pointer-events-none disabled:opacity-40"
              >
                <span className="sr-only">Remove {item}</span>
                <X aria-hidden="true" className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            id={inputId}
            value={newItem}
            onChange={(event) => handleChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => setRemovalArmed(false)}
            placeholder={items.length === 0 ? placeholder : ''}
            aria-describedby={helperId}
            enterKeyHint="done"
            className="min-w-[8rem] flex-1 border-0 bg-transparent px-0.5 py-0.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 disabled:cursor-not-allowed"
          />
        </div>

        <p id={helperId} className={SETTINGS_HELPER}>
          {duplicate
            ? `“${duplicate}” is already in the list.`
            : removalArmed
              ? `Press Backspace again to remove “${lastItem}”.`
              : items.length === 0 ? emptyMessage : 'Press Enter or comma to add.'}
          {helperText && <> {helperText}</>}
        </p>
      </div>
    </SettingsSection>
  );
};

export default TagListSection;
