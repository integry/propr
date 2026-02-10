import React from 'react';
import { PlannerAttachment, GenerationTrace, Granularity, getAttachmentUrl } from '../../api/gitfixApi';
import { Paperclip, Loader2, Sparkles } from 'lucide-react';
import { GranularityPills, AttachmentChip, RemoteAttachmentChip } from './ComposerControls';
import { GenerationProgress } from './GenerationProgress';
import { NewModeHeader, EditModeHeader } from './SetupWizardHeaders';

// Get estimated issue count based on granularity setting
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
  if (isNewMode && isCreating) {
    return (
      <>
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        <span>Creating...</span>
      </>
    );
  }
  if (!isNewMode && isGenerating) {
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
            branches={branches}
            baseBranch={baseBranch}
            isLoadingBranches={isRepoLoading}
            onBranchChange={onBranchChange}
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

    {/* Main content area */}
    <div className="flex-1 flex flex-col p-6 min-h-0">
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
      {(error || generationError) && (
        <div className="px-6 py-3 bg-red-50 border-b border-red-200 text-red-700 text-sm">
          {error || generationError}
        </div>
      )}
      {isGenerating && (
        <div className="px-6 py-3 border-b border-gray-100">
          <GenerationProgress trace={generationTrace} onAbort={onAbort} />
        </div>
      )}
      <div className="px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-gray-500">Break plan into issues:</span>
              <span className="text-xs text-gray-400">{getEstimatedIssueText(granularity)}</span>
            </div>
            <GranularityPills value={granularity} onChange={onGranularityChange} fileCount={contextFileCount} hideEstimate />
          </div>
          <button
            onClick={onGenerate}
            disabled={isGenerateDisabled}
            className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            <GenerateButtonContent isNewMode={isNewMode} isCreating={isCreating} isGenerating={isGenerating} />
          </button>
        </div>
      </div>
    </div>
  </div>
);
