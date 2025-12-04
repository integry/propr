import React from 'react';
import Alert from './Alert';

interface TagListSectionProps {
  title: string;
  description: string;
  items: string[];
  newItem: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  placeholder: string;
  emptyMessage: string;
  helperText?: string;
  onNewItemChange: (value: string) => void;
  onAddItem: () => void;
  onRemoveItem: (item: string) => void;
  onSave: () => void;
}

const TagListSection: React.FC<TagListSectionProps> = ({
  title,
  description,
  items,
  newItem,
  loading,
  saving,
  error,
  success,
  placeholder,
  emptyMessage,
  helperText,
  onNewItemChange,
  onAddItem,
  onRemoveItem,
  onSave
}) => {
  const isAddDisabled = !newItem || items.includes(newItem);
  const isSaveDisabled = saving || items.length === 0;

  return (
    <div className="mb-8">
      <h3 className="text-gray-900 text-xl font-semibold mb-4">{title}</h3>
      <p className="text-gray-600 mb-4">{description}</p>
      
      {error && <Alert message={error} type="error" />}
      {success && <Alert message={success} type="success" />}
      
      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : (
        <>
          <div className="flex gap-4 mb-4">
            <input
              value={newItem}
              onChange={(e) => onNewItemChange(e.target.value)}
              onKeyPress={(e: React.KeyboardEvent) => e.key === 'Enter' && onAddItem()}
              placeholder={placeholder}
              className="flex-1 px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <button
              onClick={onAddItem}
              disabled={isAddDisabled}
              className={`px-4 py-2 font-medium rounded-md transition-colors ${
                isAddDisabled
                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
              }`}
            >
              Add
            </button>
          </div>

          <div className="space-y-2 mb-4">
            {items.map(item => (
              <div
                key={item}
                className="flex items-center justify-between px-4 py-3 bg-gray-50 border border-gray-200 rounded-md"
              >
                <span className="font-mono text-gray-900">{item}</span>
                <button
                  onClick={() => onRemoveItem(item)}
                  className="bg-red-600 hover:bg-red-700 text-xs px-3 py-1 text-white rounded-md font-medium transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
            {items.length === 0 && (
              <p className="text-gray-600 text-center py-8">{emptyMessage}</p>
            )}
          </div>

          {helperText && (
            <p className="text-sm text-gray-600 mb-4">{helperText}</p>
          )}
          
          <button
            onClick={onSave}
            disabled={isSaveDisabled}
            className={`px-6 py-3 font-medium rounded-md transition-colors ${
              isSaveDisabled
                ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                : 'bg-primary-600 text-white hover:bg-primary-700 cursor-pointer'
            }`}
          >
            {saving ? 'Saving...' : `Save ${title}`}
          </button>
        </>
      )}
    </div>
  );
};

export default TagListSection;
