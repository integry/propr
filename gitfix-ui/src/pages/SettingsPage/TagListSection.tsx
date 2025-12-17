import React from 'react';
import { X } from 'lucide-react';

interface TagListSectionProps {
  title: string;
  description: string;
  items: string[];
  newItem: string;
  placeholder: string;
  emptyMessage: string;
  helperText?: string;
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
  onNewItemChange,
  onAddItem,
  onRemoveItem,
  className
}) => {
  const isAddDisabled = !newItem || items.includes(newItem);

  return (
    <div className={`bg-white shadow rounded-lg p-6 ${className || ''}`}>
      <h3 className="text-gray-900 text-lg font-medium mb-2">{title}</h3>
      <p className="text-gray-500 text-sm mb-4">{description}</p>
      
      <div className="flex gap-2 mb-4">
        <input
          value={newItem}
          onChange={(e) => onNewItemChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isAddDisabled && onAddItem()}
          placeholder={placeholder}
          className="flex-1 rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm px-3 py-2 border"
        />
        <button
          onClick={onAddItem}
          disabled={isAddDisabled}
          className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white ${
            isAddDisabled
              ? 'bg-gray-300 cursor-not-allowed'
              : 'bg-primary-600 hover:bg-primary-700'
          }`}
        >
          Add
        </button>
      </div>

      <div className="min-h-[3rem] bg-gray-50 rounded-md p-3 border border-gray-100">
        {items.length === 0 ? (
          <p className="text-gray-400 text-sm italic">{emptyMessage}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {items.map(item => (
              <span
                key={item}
                className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
              >
                {item}
                <button
                  type="button"
                  onClick={() => onRemoveItem(item)}
                  className="ml-1.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-blue-400 hover:bg-blue-200 hover:text-blue-500 focus:bg-blue-500 focus:text-white focus:outline-none"
                >
                  <span className="sr-only">Remove</span>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {helperText && (
        <p className="mt-3 text-sm text-gray-500">{helperText}</p>
      )}
    </div>
  );
};

export default TagListSection;