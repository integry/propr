import React from 'react';
import { PlannerAttachment, GenerationTrace, Granularity } from '../../api/gitfixApi';
import { ChevronDown, Paperclip, Loader2, Sparkles, Download } from 'lucide-react';
import { GranularityPills, AttachmentChip, RemoteAttachmentChip } from './ComposerControls';
import { GenerationProgress } from './GenerationProgress';

interface Repo { name: string; enabled: boolean; baseBranch?: string; }

// Extracted: Header for new mode (repository selector)
const NewModeHeader: React.FC<{
  reposLoading: boolean;
  selectedRepo: string;
  repos: Repo[];
  onRepoChange?: (repo: string) => void;
}> = ({ reposLoading, selectedRepo, repos, onRepoChange }) => {
  if (reposLoading) {
    return <span className="text-gray-400">Loading repositories...</span>;
  }

  // Get the selected repo's base branch for display
  const selectedRepoData = repos.find(r => r.name === selectedRepo);
  const displayBranch = selectedRepoData?.baseBranch || 'main';

  return (
    <>
      {/* Repository selector */}
      <div className="relative inline-flex items-center">
        <select
          value={selectedRepo}
          onChange={(e) => onRepoChange?.(e.target.value)}
          className="appearance-none bg-white border border-gray-300 rounded-md text-sm px-3 py-1.5 pr-8 font-medium text-gray-700 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors"
          disabled={repos.length === 0}
        >
          {repos.length === 0 ? (
            <option value="">No repositories available</option>
          ) : (
            <>
              <option value="">Select repository</option>
              {repos.map(repo => (
                <option key={repo.name} value={repo.name}>{repo.name}</option>
              ))}
            </>
          )}
        </select>
        <ChevronDown className="w-4 h-4 text-gray-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
      {/* Show branch when repo is selected */}
      {selectedRepo && (
        <>
          <span className="text-gray-400">&gt;</span>
          <span className="text-gray-600">{displayBranch}</span>
        </>
      )}
    </>
  );
};

// Extracted: Header for edit mode (branch selector)
const EditModeHeader: React.FC<{
  repository: string;
  isRepoLoading: boolean;
  baseBranch: string;
  branches: string[];
  branchError: string | null;
  repoError: string | null;
  onBranchChange: (branch: string) => void;
}> = ({ repository, isRepoLoading, baseBranch, branches, branchError, repoError, onBranchChange }) => (
  <>
    <span className="font-medium text-gray-700">{repository}</span>
    <span className="text-gray-400">&gt;</span>
    <div className="relative inline-flex items-center">
      {isRepoLoading ? (
        <span className="text-gray-400">Loading...</span>
      ) : (
        <>
          <select
            value={baseBranch}
            onChange={(e) => onBranchChange(e.target.value)}
            className="appearance-none bg-white border border-gray-300 rounded-md text-sm px-3 py-1.5 pr-8 text-gray-700 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors"
            disabled={branches.length === 0}
          >
            {branches.length === 0 ? (
              <option value="">No branches</option>
            ) : (
              branches.map(branch => (
                <option key={branch} value={branch}>{branch}</option>
              ))
            )}
          </select>
          <ChevronDown className="w-4 h-4 text-gray-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
        </>
      )}
    </div>
    {(branchError || repoError) && (
      <span className="text-red-500 text-xs ml-2">{branchError || repoError}</span>
    )}
  </>
);

// Extracted: Attachments section
const AttachmentsSection: React.FC<{
  isNewMode: boolean;
  localFiles: File[];
  files: PlannerAttachment[];
  onRemoveLocalFile?: (fileIndex: number) => void;
  onRemoveFile: (attachmentId: string) => void;
  isUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({ isNewMode, localFiles, files, onRemoveLocalFile, onRemoveFile, isUploading, fileInputRef, onFileInputChange }) => {
  const hasLocalFiles = isNewMode && localFiles.length > 0;
  const hasRemoteFiles = !isNewMode && files.length > 0;
  const hasAnyFiles = hasLocalFiles || hasRemoteFiles;

  return (
    <div className="mt-4 flex items-center gap-3 flex-wrap">
      {/* Attach button - always first */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={onFileInputChange}
        className="hidden"
        accept="image/*,.log,.txt,.json"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors border border-gray-200"
      >
        {isUploading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Uploading...</span>
          </>
        ) : (
          <>
            <Paperclip className="w-4 h-4" />
            <span>Attach file</span>
          </>
        )}
      </button>

      {/* Attached files shown inline after the button */}
      {hasAnyFiles && (
        <div className="flex flex-wrap gap-2">
          {hasLocalFiles && localFiles.map((file, index) => (
            <AttachmentChip
              key={`file-${index}`}
              file={file}
              onRemove={() => onRemoveLocalFile?.(index)}
            />
          ))}
          {hasRemoteFiles && files.map((attachment) => (
            <RemoteAttachmentChip
              key={attachment.id}
              name={attachment.originalName}
              mimeType={attachment.mimeType}
              tokenEstimate={attachment.tokenEstimate}
              onRemove={() => onRemoveFile(attachment.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Extracted: Generate button content
const GenerateButtonContent: React.FC<{
  isNewMode: boolean;
  isCreating: boolean;
  isGenerating: boolean;
}> = ({ isNewMode, isCreating, isGenerating }) => {
  if (isNewMode) {
    if (isCreating) {
      return (
        <>
          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          <span>Creating...</span>
        </>
      );
    }
    return (
      <>
        <Sparkles className="w-4 h-4" />
        <span>Generate Plan</span>
      </>
    );
  }
  if (isGenerating) {
    return (
      <>
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        <span>Generating...</span>
      </>
    );
  }
  return (
    <>
      <Sparkles className="w-4 h-4" />
      <span>Generate Plan</span>
    </>
  );
};

interface SetupWizardLeftPaneProps {
  isNewMode: boolean;
  repository: string;
  repos?: Repo[];
  selectedRepo?: string;
  onRepoChange?: (repo: string) => void;
  reposLoading?: boolean;
  baseBranch: string;
  branches: string[];
  isRepoLoading: boolean;
  branchError: string | null;
  repoError: string | null;
  onBranchChange: (branch: string) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  autoResize: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  files: PlannerAttachment[];
  localFiles?: File[];
  onRemoveFile: (attachmentId: string) => void;
  onRemoveLocalFile?: (fileIndex: number) => void;
  isUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isPreviewLoading: boolean;
  error: string | null;
  generationError: string | null;
  isGenerating: boolean;
  isCreating?: boolean;
  generationTrace?: GenerationTrace;
  onAbort: () => Promise<void>;
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
  isExporting: boolean;
  canExport: boolean;
  onExport: () => void;
  isGenerateDisabled: boolean;
  onGenerate: () => void;
}

export const SetupWizardLeftPane: React.FC<SetupWizardLeftPaneProps> = ({
  isNewMode,
  repository,
  repos = [],
  selectedRepo = '',
  onRepoChange,
  reposLoading = false,
  baseBranch,
  branches,
  isRepoLoading,
  branchError,
  repoError,
  onBranchChange,
  prompt,
  onPromptChange,
  textareaRef,
  autoResize,
  onPaste,
  files,
  localFiles = [],
  onRemoveFile,
  onRemoveLocalFile,
  isUploading,
  fileInputRef,
  onFileInputChange,
  isPreviewLoading,
  error,
  generationError,
  isGenerating,
  isCreating = false,
  generationTrace,
  onAbort,
  granularity,
  onGranularityChange,
  isExporting,
  canExport,
  onExport,
  isGenerateDisabled,
  onGenerate
}) => (
  <div className="w-[65%] h-full flex flex-col border-r border-gray-100">
    {/* Header with repo/branch */}
    <div className="px-6 py-3 border-b border-gray-100">
      <div className="flex items-center gap-2 text-sm">
        {isNewMode ? (
          <NewModeHeader
            reposLoading={reposLoading}
            selectedRepo={selectedRepo}
            repos={repos}
            onRepoChange={onRepoChange}
          />
        ) : (
          <EditModeHeader
            repository={repository}
            isRepoLoading={isRepoLoading}
            baseBranch={baseBranch}
            branches={branches}
            branchError={branchError}
            repoError={repoError}
            onBranchChange={onBranchChange}
          />
        )}
      </div>
    </div>

    {/* Main content area */}
    <div className="flex-1 flex flex-col p-6 min-h-0 overflow-auto">
      <div className="flex-1 flex flex-col min-h-0">
        {/* Prompt textarea */}
        <div className="flex-1 min-h-0 flex flex-col" style={{ maxHeight: '60%' }}>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onInput={autoResize}
            onPaste={onPaste}
            placeholder="Describe the feature, bug fix, or improvement you want to implement..."
            className="flex-1 w-full text-base text-gray-900 placeholder-gray-400 resize-none leading-relaxed border border-gray-200 rounded-lg p-4 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            style={{ minHeight: '160px' }}
          />
        </div>

        {/* Attachments section */}
        <AttachmentsSection
          isNewMode={isNewMode}
          localFiles={localFiles}
          files={files}
          onRemoveLocalFile={onRemoveLocalFile}
          onRemoveFile={onRemoveFile}
          isUploading={isUploading}
          fileInputRef={fileInputRef}
          onFileInputChange={onFileInputChange}
        />
      </div>
    </div>

    {/* Footer with error, generation progress, and actions */}
    <div className="border-t border-gray-100 bg-white">
      {/* Error display */}
      {(error || generationError) && (
        <div className="px-6 py-3 bg-red-50 border-b border-red-200 text-red-700 text-sm">
          {error || generationError}
        </div>
      )}

      {/* Generation Progress */}
      {isGenerating && (
        <div className="px-6 py-3 border-b border-gray-100">
          <GenerationProgress trace={generationTrace} onAbort={onAbort} />
        </div>
      )}

      {/* Action bar */}
      <div className="px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Granularity:</span>
            <GranularityPills
              value={granularity}
              onChange={onGranularityChange}
            />
          </div>
          <div className="flex items-center gap-3">
            {/* Export Context Button */}
            <button
              onClick={onExport}
              disabled={isExporting || isPreviewLoading || !canExport}
              className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-900 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
              title="Export context as file"
            >
              {isExporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              <span>Export</span>
            </button>

            {/* Generate Plan Button */}
            <button
              onClick={onGenerate}
              disabled={isGenerateDisabled}
              className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              <GenerateButtonContent
                isNewMode={isNewMode}
                isCreating={isCreating}
                isGenerating={isGenerating}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
);
