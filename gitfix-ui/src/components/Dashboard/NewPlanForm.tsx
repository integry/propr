import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { X, Paperclip, Loader2, Image } from 'lucide-react';

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
}) => (
  <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8 shadow-md hover:shadow-lg transition-shadow border-t-4 border-t-indigo-500">
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
      <div>
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
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">What do you want to build?</label>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onPaste={onPaste}
          placeholder="Describe the feature or task you want to implement..."
          rows={3}
          className="w-full px-3 py-2 bg-white text-gray-900 placeholder-gray-400 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none"
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
);
