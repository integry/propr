import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { X, Paperclip, Loader2, Image, FolderGit2 } from 'lucide-react';

export interface Repo {
  name: string;
  enabled: boolean;
  baseBranch?: string;
}

// Component for displaying file preview with image thumbnails
const FilePreview: React.FC<{
  file: File;
  index: number;
  onRemove: (index: number) => void;
}> = ({ file, index, onRemove }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith('image/');

  useEffect(() => {
    if (isImage) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [file, isImage]);

  return (
    <div className="inline-flex flex-col items-center bg-gray-50 border border-gray-200 rounded-lg p-2 relative group">
      <button
        onClick={() => onRemove(index)}
        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 z-10"
        title="Remove"
        type="button"
      >
        <X className="w-3 h-3" />
      </button>

      {isImage && previewUrl ? (
        <div className="w-20 h-20 mb-1.5 overflow-hidden rounded bg-gray-100 flex items-center justify-center">
          <img
            src={previewUrl}
            alt={file.name}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      ) : (
        <div className="w-20 h-20 mb-1.5 overflow-hidden rounded bg-gray-100 flex items-center justify-center">
          <Paperclip className="w-6 h-6 text-gray-400" />
        </div>
      )}

      <div className="flex items-center gap-1 max-w-[80px]">
        {isImage ? (
          <Image className="w-3 h-3 text-indigo-500 flex-shrink-0" />
        ) : (
          <Paperclip className="w-3 h-3 text-gray-500 flex-shrink-0" />
        )}
        <span className="text-xs text-gray-700 truncate" title={file.name}>
          {file.name}
        </span>
      </div>
    </div>
  );
};

export interface NewPlanFormProps {
  repos: Repo[];
  selectedRepo: string;
  onRepoChange: (repo: string) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  selectedFiles: File[];
  onRemoveFile: (index: number) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isPastingImage: boolean;
  error: string | null;
  isCreating: boolean;
  onStartPlanning: () => void;
  isExpanded?: boolean;
  onExpandChange?: (expanded: boolean) => void;
}

export const NewPlanForm: React.FC<NewPlanFormProps> = ({
  repos,
  selectedRepo,
  onRepoChange,
  prompt,
  onPromptChange,
  onPaste,
  selectedFiles,
  onRemoveFile,
  onFileSelect,
  fileInputRef,
  isPastingImage,
  error,
  isCreating,
  onStartPlanning,
  isExpanded: controlledExpanded,
  onExpandChange,
}) => {
  const navigate = useNavigate();
  // Use internal state if not controlled externally
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [shouldFocusTextarea, setShouldFocusTextarea] = useState(false);

  const handleExpand = () => {
    if (onExpandChange) {
      onExpandChange(true);
    } else {
      setInternalExpanded(true);
    }
    setShouldFocusTextarea(true);
  };

  // Auto-expand textarea based on content
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to calculate new scroll height
      textarea.style.height = 'auto';
      // Set minimum height (10 rows ~ 240px on mobile, 8 rows ~ 192px on desktop) and max height
      const isMobile = window.innerWidth < 640;
      const minHeight = isMobile ? 240 : 192;
      const maxHeight = isMobile ? 500 : 400;
      const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
      textarea.style.height = `${newHeight}px`;
    }
  };

  // Focus textarea when it becomes visible after expansion
  useEffect(() => {
    if (shouldFocusTextarea && textareaRef.current) {
      textareaRef.current.focus();
      setShouldFocusTextarea(false);
    }
  }, [shouldFocusTextarea, isExpanded]);

  // Adjust height when prompt changes
  useEffect(() => {
    if (isExpanded || prompt.trim().length > 0 || selectedFiles.length > 0) {
      adjustTextareaHeight();
    }
  }, [prompt, isExpanded, selectedFiles.length]);

  // Auto-expand if there's content or files
  const shouldBeExpanded = isExpanded || prompt.trim().length > 0 || selectedFiles.length > 0;

  // Empty state when no repositories are configured
  if (repos.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8 shadow-md hover:shadow-lg transition-all duration-300 border-t-4 border-t-indigo-500">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <span>✨</span> Start New AI Plan
          </h3>
          <Link
            to="/plans"
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            View History
          </Link>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center mb-4">
            <FolderGit2 className="w-8 h-8 text-indigo-500" />
          </div>
          <h4 className="text-lg font-medium text-gray-900 mb-2">No repositories configured</h4>
          <p className="text-gray-500 mb-6 max-w-md">
            Add a repository to start creating AI-powered plans for your codebase.
          </p>
          <button
            onClick={() => navigate('/repositories')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white font-medium rounded-md hover:bg-primary-700 transition-colors"
          >
            <FolderGit2 className="w-4 h-4" />
            Add a Repository
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-white border border-gray-200 rounded-lg p-6 mb-8 shadow-md hover:shadow-lg transition-all duration-300 border-t-4 border-t-indigo-500`}>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <span>✨</span> Start New AI Plan
        </h3>
        <Link
          to="/plans"
          className="text-sm text-gray-500 hover:text-gray-700 underline"
        >
          View History
        </Link>
      </div>
      <div className="space-y-4">
        {/* Repository Select - Always visible */}
        <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-end">
          <div className="flex-shrink-0 w-full sm:w-64">
            <label className="block text-sm font-medium text-gray-700 mb-2">Repository</label>
            <select
              value={selectedRepo}
              onChange={(e) => onRepoChange(e.target.value)}
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              disabled={repos.length === 0}
            >
              {repos.length === 0 ? (
                <option value="">No repositories configured</option>
              ) : (
                repos.map(repo => (
                  <option key={repo.name} value={repo.name}>
                    {repo.baseBranch ? `${repo.name} (${repo.baseBranch})` : repo.name}
                  </option>
                ))
              )}
            </select>
          </div>
          {/* Compact Input - visible when collapsed */}
          {!shouldBeExpanded && (
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-2">What do you want to build?</label>
              <input
                type="text"
                value={prompt}
                onChange={(e) => onPromptChange(e.target.value)}
                onFocus={handleExpand}
                placeholder="Describe the feature or task you want to implement..."
                className="w-full px-3 py-2 bg-white text-gray-900 placeholder-gray-400 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
          )}
        </div>

        {/* Expanded Section */}
        <div className={`transition-all duration-300 overflow-hidden ${shouldBeExpanded ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">What do you want to build?</label>
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => {
                  onPromptChange(e.target.value);
                  adjustTextareaHeight();
                }}
                onPaste={onPaste}
                placeholder="Describe the feature or task you want to implement..."
                rows={10}
                className="w-full px-3 py-2 bg-white text-gray-900 placeholder-gray-400 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-y min-h-[240px] sm:min-h-[192px]"
              />
              <p className="text-xs text-gray-400 mt-1">Tip: You can paste screenshots directly into this field</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Attachments (optional)</label>
              {selectedFiles.length > 0 && (
                <div className="flex flex-wrap gap-3 mb-3">
                  {selectedFiles.map((file, index) => (
                    <FilePreview
                      key={`${file.name}-${index}`}
                      file={file}
                      index={index}
                      onRemove={onRemoveFile}
                    />
                  ))}
                </div>
              )}
              <input
                type="file"
                ref={fileInputRef}
                onChange={onFileSelect}
                className="hidden"
                id="dashboard-file-upload"
                accept="image/*,.log,.txt,.json,.md,.csv"
                multiple
              />
              <label
                htmlFor="dashboard-file-upload"
                className={`inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-primary-600 cursor-pointer transition-colors ${isPastingImage ? 'opacity-50' : ''}`}
              >
                {isPastingImage ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing pasted image...
                  </>
                ) : (
                  <>
                    <Paperclip className="w-4 h-4" />
                    Attach screenshots, logs, or files
                  </>
                )}
              </label>
            </div>
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                {error}
              </div>
            )}
            <button
              onClick={onStartPlanning}
              disabled={isCreating || !selectedRepo || !prompt.trim()}
              className={`w-full py-3 font-medium rounded-md transition-colors ${
                isCreating || !selectedRepo || !prompt.trim()
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-primary-600 text-white hover:bg-primary-700 cursor-pointer'
              }`}
            >
              {isCreating ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {selectedFiles.length > 0 ? 'Creating & uploading files...' : 'Creating...'}
                </span>
              ) : (
                'Start Planning'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
