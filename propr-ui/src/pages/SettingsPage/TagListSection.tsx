import React from 'react';
import { CornerDownLeft, X } from 'lucide-react';
import { SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL, SETTINGS_LABEL } from './settingsStyles';

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
  onAddItem: () => void;
  onRemoveItem: (item: string) => void;
  className?: string;
}

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
  onAddItem,
  onRemoveItem,
  className
}) => {
  const isAddDisabled = !newItem || items.includes(newItem);
  const inputId = `tag-list-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <SettingsSection title={title} description={description} className={className}>
      <div className="mb-6 max-w-2xl">
        <label className={SETTINGS_LABEL} htmlFor={inputId}>{addLabel}</label>
        <div className="mt-1.5 flex items-stretch gap-2">
          <input
            id={inputId}
            value={newItem}
            onChange={(e) => onNewItemChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!isAddDisabled) onAddItem();
            }}
            placeholder={placeholder}
            className={SETTINGS_CONTROL}
          />
          <button
            type="button"
            onClick={onAddItem}
            disabled={isAddDisabled}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-white"
          >
            <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5" />
            Add
          </button>
        </div>

        {items.length === 0 ? (
          <p className="mt-3 text-[12px] leading-5 text-slate-500">{emptyMessage}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {items.map(item => (
              <span
                key={item}
                className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-700"
              >
                {item}
                <button
                  type="button"
                  onClick={() => onRemoveItem(item)}
                  className="ml-1.5 inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-300 hover:text-slate-700 focus:bg-slate-400 focus:text-white focus:outline-none"
                >
                  <span className="sr-only">Remove {item}</span>
                  <X aria-hidden="true" className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {helperText && <p className="mt-2 text-[12px] leading-5 text-slate-500">{helperText}</p>}
      </div>
    </SettingsSection>
  );
};

export default TagListSection;
