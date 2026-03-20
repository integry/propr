import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FileText, X, Plus, FolderOpen } from 'lucide-react';

interface ManualFileSelectorProps {
  files: string[];
  onAddFile: (filePath: string) => void;
  onRemoveFile: (filePath: string) => void;
  disabled?: boolean;
}

/**
 * Component that allows users to manually add specific file paths to include in the context.
 * Files are displayed as chips with a remove button.
 */
export const ManualFileSelector: React.FC<ManualFileSelectorProps> = ({
  files,
  onAddFile,
  onRemoveFile,
  disabled = false
}) => {
  const [inputValue, setInputValue] = useState('');
  const [isInputVisible, setIsInputVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when it becomes visible
  useEffect(() => {
    if (isInputVisible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isInputVisible]);

  const handleAddFile = useCallback(() => {
    const trimmedPath = inputValue.trim();
    if (!trimmedPath) return;

    // Normalize path: remove leading slashes
    const normalizedPath = trimmedPath.replace(/^\/+/, '');

    // Don't add duplicates
    if (files.includes(normalizedPath)) {
      setInputValue('');
      setIsInputVisible(false);
      return;
    }

    onAddFile(normalizedPath);
    setInputValue('');
    setIsInputVisible(false);
  }, [inputValue, files, onAddFile]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddFile();
    } else if (e.key === 'Escape') {
      setInputValue('');
      setIsInputVisible(false);
    }
  }, [handleAddFile]);

  const handleBlur = useCallback(() => {
    // If there's text, add it; otherwise just close
    if (inputValue.trim()) {
      handleAddFile();
    } else {
      setIsInputVisible(false);
    }
  }, [inputValue, handleAddFile]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Add file button/input */}
      {isInputVisible ? (
        <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-300 rounded-lg px-2 py-1">
          <FolderOpen className="w-4 h-4 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder="src/path/to/file.ts"
            className="w-48 sm:w-64 bg-transparent text-sm text-gray-900 placeholder-gray-400 focus:outline-none"
            disabled={disabled}
          />
          <button
            type="button"
            onClick={handleAddFile}
            disabled={!inputValue.trim() || disabled}
            className="p-0.5 text-gray-500 hover:text-teal-600 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Add file"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsInputVisible(true)}
          disabled={disabled}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors ${
            disabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          <FolderOpen className="w-4 h-4" />
          <span>Add files</span>
        </button>
      )}

      {/* Selected files shown as chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((filePath) => (
            <div
              key={filePath}
              className="inline-flex items-center gap-1.5 bg-teal-50 border border-teal-200 rounded-lg px-2.5 py-1.5 text-sm"
            >
              <FileText className="w-3.5 h-3.5 text-teal-600 flex-shrink-0" />
              <span className="text-teal-800 font-mono text-xs max-w-[200px] truncate" title={filePath}>
                {filePath}
              </span>
              <button
                type="button"
                onClick={() => onRemoveFile(filePath)}
                disabled={disabled}
                className="p-0.5 text-teal-500 hover:text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                title="Remove file"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ManualFileSelector;
