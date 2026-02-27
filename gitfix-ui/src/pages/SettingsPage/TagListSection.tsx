import React from 'react';

interface TagListSectionProps {
  title: string;
  description: string;
  items: string[];
  newItem: string;
  placeholder: string;
  emptyMessage: string;
  helperText?: string;
  showEmptyIcon?: boolean;
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
  showEmptyIcon,
  onNewItemChange,
  onAddItem,
  onRemoveItem,
  className
}) => {
  const isAddDisabled = !newItem || items.includes(newItem);

  return (
    <div className={className || ''}>
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{title}</h4>
      <p className="text-gray-500 text-xs mb-3">{description}</p>

      {/* Input with embedded Add button */}
      <div className="relative mb-3">
        <input
          value={newItem}
          onChange={(e) => onNewItemChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isAddDisabled && onAddItem()}
          placeholder={placeholder}
          className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 pr-14 border"
        />
        <button
          onClick={onAddItem}
          disabled={isAddDisabled}
          className={`absolute right-1 top-1/2 -translate-y-1/2 px-2 py-0.5 text-xs font-medium rounded transition-colors ${
            isAddDisabled
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-primary-600 hover:bg-primary-50'
          }`}
        >
          Add
        </button>
      </div>

      {/* Tags display area */}
      <div className="min-h-[2.5rem] bg-gray-50 rounded p-2.5 border border-gray-100">
        {items.length === 0 ? (
          showEmptyIcon ? (
            <div className="flex flex-col items-center justify-center py-1">
              <svg className="w-4 h-4 text-gray-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <p className="text-gray-400 text-xs">{emptyMessage}</p>
            </div>
          ) : (
            <p className="text-gray-400 text-xs italic">{emptyMessage}</p>
          )
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {items.map(item => (
              <span
                key={item}
                className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-slate-200 text-slate-700"
              >
                {item}
                <button
                  type="button"
                  onClick={() => onRemoveItem(item)}
                  className="ml-1.5 inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-300 hover:text-slate-600 focus:bg-slate-400 focus:text-white focus:outline-none"
                >
                  <span className="sr-only">Remove {item}</span>
                  <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {helperText && (
        <p className="mt-2 text-xs text-gray-500">{helperText}</p>
      )}
    </div>
  );
};

export default TagListSection;
