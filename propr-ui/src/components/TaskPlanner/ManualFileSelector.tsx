import React, { useState, useCallback, useRef, useEffect } from 'react';
import { X, FileCode, Plus, Search } from 'lucide-react';

interface ManualFileSelectorProps {
  manualFiles: string[];
  onAddFile: (filePath: string) => void;
  onRemoveFile: (filePath: string) => void;
  disabled?: boolean;
}

// Get appropriate icon color based on file extension
const getFileIconColor = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'text-blue-500';
    case 'js':
    case 'jsx':
      return 'text-yellow-500';
    case 'json':
      return 'text-green-500';
    case 'py':
      return 'text-blue-400';
    case 'css':
    case 'scss':
    case 'sass':
      return 'text-pink-500';
    default:
      return 'text-gray-500';
  }
};

// Extract filename from path for display
const getFileName = (path: string): string => {
  const parts = path.split('/');
  return parts[parts.length - 1];
};

// File chip component for displaying selected files
const FileChip: React.FC<{
  path: string;
  onRemove: () => void;
  disabled?: boolean;
}> = ({ path, onRemove, disabled }) => {
  const fileName = getFileName(path);
  const iconColor = getFileIconColor(path);

  return (
    <div
      className="inline-flex items-center gap-1.5 bg-gray-100 border border-gray-200 rounded-md px-2 py-1 text-sm group"
      title={path}
    >
      <FileCode className={`w-3.5 h-3.5 ${iconColor} flex-shrink-0`} />
      <span className="text-gray-700 max-w-[180px] truncate font-mono text-xs">
        {fileName}
      </span>
      {!disabled && (
        <button
          onClick={onRemove}
          className="p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors opacity-0 group-hover:opacity-100"
          title="Remove file"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
};

export const ManualFileSelector: React.FC<ManualFileSelectorProps> = ({
  manualFiles,
  onAddFile,
  onRemoveFile,
  disabled = false
}) => {
  const [inputValue, setInputValue] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when expanded
  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded]);

  const handleAddFile = useCallback(() => {
    const trimmedPath = inputValue.trim();
    if (!trimmedPath) return;

    // Normalize path - remove leading slash if present
    const normalizedPath = trimmedPath.startsWith('/')
      ? trimmedPath.slice(1)
      : trimmedPath;

    // Check for duplicates
    if (manualFiles.includes(normalizedPath)) {
      setInputValue('');
      return;
    }

    onAddFile(normalizedPath);
    setInputValue('');
  }, [inputValue, manualFiles, onAddFile]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddFile();
    } else if (e.key === 'Escape') {
      setInputValue('');
      setIsExpanded(false);
    }
  }, [handleAddFile]);

  const handleBlur = useCallback(() => {
    // Only collapse if input is empty
    if (!inputValue.trim()) {
      setIsExpanded(false);
    }
  }, [inputValue]);

  return (
    <div className="flex flex-col gap-2">
      {/* Selected files */}
      {manualFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {manualFiles.map((filePath) => (
            <FileChip
              key={filePath}
              path={filePath}
              onRemove={() => onRemoveFile(filePath)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="flex items-center gap-2">
        {isExpanded ? (
          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                disabled={disabled}
                placeholder="Enter file path (e.g., src/components/App.tsx)"
                className={`w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-teal-500 focus:border-teal-500 ${
                  disabled ? 'bg-gray-50 cursor-not-allowed' : ''
                }`}
              />
            </div>
            <button
              onClick={handleAddFile}
              disabled={disabled || !inputValue.trim()}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-md disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Add</span>
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsExpanded(true)}
            disabled={disabled}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors ${
              disabled ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            <Plus className="w-4 h-4" />
            <span>Add files to context</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default ManualFileSelector;
