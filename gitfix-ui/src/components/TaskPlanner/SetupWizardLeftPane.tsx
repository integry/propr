import React from 'react';
import { PlannerAttachment, GenerationTrace, Granularity, getAttachmentUrl } from '../../api/gitfixApi';
import { ChevronDown, Paperclip, Loader2, Sparkles, Github } from 'lucide-react';
import { GranularityPills, AttachmentChip, RemoteAttachmentChip } from './ComposerControls';
import { GenerationProgress } from './GenerationProgress';

// Helper to get estimated issue count text
const getEstimatedIssueText = (granularity: Granularity): string => {
  const counts: Record<Granularity, string> = {
    single: '1',
    balanced: '3-5',
    granular: '5-10',
  };
  const count = counts[granularity] || '1';
  return `${count} ${count === '1' ? 'issue' : 'issues'}`;
};

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
      {/* Repository selector with GitHub icon */}
      <div className="relative inline-flex items-center max-w-[50%]">
        <Github className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <select
          value={selectedRepo}
          onChange={(e) => onRepoChange?.(e.target.value)}
          className="appearance-none bg-white border border-gray-300 rounded-md text-sm pl-8 pr-8 py-1.5 font-mono text-gray-700 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors truncate max-w-full"
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
          <span className="text-gray-400 flex-shrink-0">/</span>
          <span className="text-gray-600 font-mono truncate max-w-[50%]">{displayBranch}</span>
        </>
      )}
    </>
  );
};

// Helper to format repository name with bold repo part
const FormatRepoName: React.FC<{ repository: string }> = ({ repository }) => {
  const parts = repository.split('/');
  if (parts.length === 2) {
    return (
      <>
        <span className="text-gray-500">{parts[0]}/</span>
        <span className="font-semibold text-gray-700">{parts[1]}</span>
      </>
    );
  }
  return <span className="text-gray-700">{repository}</span>;
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
  isChangingRepo: boolean;
  onChangeRepoClick: () => void;
  repos: Repo[];
  onRepoChange: (repo: string) => void;
  reposLoading: boolean;
}> = ({ repository, isRepoLoading, baseBranch, branches, branchError, repoError, onBranchChange, isChangingRepo, onChangeRepoClick, repos, onRepoChange, reposLoading }) => (
  <>
    {isChangingRepo ? (
      /* Repository dropdown when changing */
      <div className="relative inline-flex items-center max-w-[50%]">
        <Github className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <select
          value={repository}
          onChange={(e) => onRepoChange(e.target.value)}
          className="appearance-none bg-white border border-gray-300 rounded-md text-sm pl-8 pr-8 py-1.5 font-mono text-gray-700 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors truncate max-w-full"
          disabled={reposLoading || repos.length === 0}
        >
          {reposLoading ? (
            <option value="">Loading...</option>
          ) : repos.length === 0 ? (
            <option value="">No repositories available</option>
          ) : (
            repos.map(repo => (
              <option key={repo.name} value={repo.name}>{repo.name}</option>
            ))
          )}
        </select>
        <ChevronDown className="w-4 h-4 text-gray-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
    ) : (
      /* Static repository display */
      <div className="inline-flex items-center gap-1.5 max-w-[50%]">
        <Github className="w-4 h-4 text-gray-500 flex-shrink-0" />
        <span className="font-mono truncate"><FormatRepoName repository={repository} /></span>
      </div>
    )}
    <span className="text-gray-400 flex-shrink-0">/</span>
    <div className="relative inline-flex items-center max-w-[50%]">
      {isRepoLoading ? (
        <span className="text-gray-400">Loading...</span>
      ) : (
        <>
          <select
            value={baseBranch}
            onChange={(e) => onBranchChange(e.target.value)}
            className="appearance-none bg-white border border-gray-300 rounded-md text-sm px-3 py-1.5 pr-8 font-mono text-gray-700 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors truncate max-w-full"
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
    {/* Change repo link */}
    {!isChangingRepo && (
      <button
        onClick={onChangeRepoClick}
        className="text-xs text-indigo-600 hover:text-indigo-800 ml-2 flex-shrink-0 hover:underline"
      >
        change repo
      </button>
    )}
    {(branchError || repoError) && (
      <span className="text-red-500 text-xs ml-2 flex-shrink-0">{branchError || repoError}</span>
    )}
  </>
);

// Extracted: Attachments section
const AttachmentsSection: React.FC<{
  isNewMode: boolean;
  localFiles: File[];
  files: PlannerAttachment[];
  draftId?: string;
  onRemoveLocalFile?: (fileIndex: number) => void;
  onRemoveFile: (attachmentId: string) => void;
  isUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({ isNewMode, localFiles, files, draftId, onRemoveLocalFile, onRemoveFile, isUploading, fileInputRef, onFileInputChange }) => {
  const hasLocalFiles = isNewMode && localFiles.length > 0;
  const hasRemoteFiles = !isNewMode && files.length > 0;
  const hasAnyFiles = hasLocalFiles || hasRemoteFiles;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Attach button - always first */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={onFileInputChange}
        className="hidden"
        accept="image/*,.log,.txt,.json"
        multiple
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
            <span>Attach files</span>
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
              previewUrl={draftId && attachment.mimeType?.startsWith('image/') ? getAttachmentUrl(draftId, attachment.id) : undefined}
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
  isChangingRepo?: boolean;
  onChangeRepoClick?: () => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  autoResize: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  files: PlannerAttachment[];
  localFiles?: File[];
  draftId?: string;
  onRemoveFile: (attachmentId: string) => void;
  onRemoveLocalFile?: (fileIndex: number) => void;
  isUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error: string | null;
  generationError: string | null;
  isGenerating: boolean;
  isCreating?: boolean;
  generationTrace?: GenerationTrace;
  onAbort: () => Promise<void>;
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
  contextFileCount?: number;
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
  isChangingRepo = false,
  onChangeRepoClick,
  prompt,
  onPromptChange,
  textareaRef,
  autoResize,
  onPaste,
  files,
  localFiles = [],
  draftId,
  onRemoveFile,
  onRemoveLocalFile,
  isUploading,
  fileInputRef,
  onFileInputChange,
  error,
  generationError,
  isGenerating,
  isCreating = false,
  generationTrace,
  onAbort,
  granularity,
  onGranularityChange,
  contextFileCount,
  isGenerateDisabled,
  onGenerate
}) => (
  <div className="w-[65%] h-full flex flex-col border-r border-gray-100">
    {/* Header with repo/branch */}
    <div className="px-6 py-3 border-b border-gray-100">
      <div className="flex items-center gap-2 text-sm flex-nowrap overflow-hidden">
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
            isChangingRepo={isChangingRepo}
            onChangeRepoClick={onChangeRepoClick || (() => {})}
            repos={repos}
            onRepoChange={onRepoChange || (() => {})}
            reposLoading={reposLoading}
          />
        )}
      </div>
    </div>

    {/* Main content area - flex-grow to fill space between header and footer */}
    <div className="flex-1 flex flex-col p-6 min-h-0">
      {/* Text input container - grows to fill available space */}
      <div className="flex-1 flex flex-col min-h-0 relative border border-gray-200 rounded-lg focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onInput={autoResize}
          onPaste={onPaste}
          placeholder="Describe the feature, bug fix, or improvement you want to implement..."
          className="flex-1 w-full text-base text-gray-900 placeholder-gray-400 resize-none leading-relaxed p-4 pb-16 focus:outline-none rounded-lg"
          style={{ minHeight: '160px' }}
        />
        {/* Attachments pinned to bottom of text area */}
        <div className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-white border-t border-gray-100 rounded-b-lg">
          <AttachmentsSection
            isNewMode={isNewMode}
            localFiles={localFiles}
            files={files}
            draftId={draftId}
            onRemoveLocalFile={onRemoveLocalFile}
            onRemoveFile={onRemoveFile}
            isUploading={isUploading}
            fileInputRef={fileInputRef}
            onFileInputChange={onFileInputChange}
          />
        </div>
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
        <div className="flex items-start justify-between gap-4">
          {/* Left side: Granularity in 2 rows */}
          <div className="flex flex-col gap-2">
            {/* Row 1: Label and estimated issues */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-gray-500">Break plan into issues:</span>
              <span className="text-xs text-gray-400">
                {getEstimatedIssueText(granularity)}
              </span>
            </div>
            {/* Row 2: Granularity pills */}
            <GranularityPills
              value={granularity}
              onChange={onGranularityChange}
              fileCount={contextFileCount}
              hideEstimate
            />
          </div>
          {/* Right side: Generate Plan Button */}
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
);
