import React from 'react';
import { PlannerAttachment, GenerationTrace, getAttachmentUrl } from '../../api/proprApi';
import { Paperclip, Loader2 } from 'lucide-react';
import { AttachmentChip, RemoteAttachmentChip } from './ComposerControls';
import { GenerationProgress } from './GenerationProgress';
import { NewModeHeader, EditModeHeader } from './SetupWizardHeaders';
import { ManualFileSelector } from './ManualFileSelector';
import { RepoSelection } from '../RepositorySelector';

interface Repo { name: string; enabled: boolean; baseBranch?: string; starred?: boolean; iconPath?: string | null; }

// Extracted: Attachments section
const AttachmentsSection: React.FC<{
  isNewMode: boolean;
  localFiles: File[];
  files: PlannerAttachment[];
  draftId?: string;
  onRemoveLocalFile?: (fileIndex: number) => void;
  onRemoveFile: (attachmentId: string) => void;
  isUploading: boolean;
  isGenerating: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({ isNewMode, localFiles, files, draftId, onRemoveLocalFile, onRemoveFile, isUploading, isGenerating, fileInputRef, onFileInputChange }) => {
  const safeLocalFiles = Array.isArray(localFiles) ? localFiles : [];
  const safeFiles = Array.isArray(files) ? files : [];
  const hasLocalFiles = isNewMode && safeLocalFiles.length > 0;
  const hasRemoteFiles = !isNewMode && safeFiles.length > 0;
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
        disabled={isUploading || isGenerating}
        className={`flex items-center gap-1.5 px-4 py-2 text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors ${
          isGenerating ? 'opacity-50 cursor-not-allowed' : ''
        }`}
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
          {hasLocalFiles && safeLocalFiles.map((file, index) => (
            <AttachmentChip
              key={`file-${index}`}
              file={file}
              onRemove={() => onRemoveLocalFile?.(index)}
            />
          ))}
          {hasRemoteFiles && safeFiles.map((attachment) => (
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

interface SetupWizardLeftPaneProps {
  isNewMode: boolean;
  repository: string;
  repos?: Repo[];
  selectedRepo?: string;
  selectedBaseBranch?: string;
  configuredBaseBranch?: string;
  onRepoChange?: (repo: string, selection?: RepoSelection) => void;
  reposLoading?: boolean;
  baseBranch: string;
  isRepoLoading: boolean;
  branchError: string | null;
  repoError: string | null;
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
  generationTrace?: GenerationTrace;
  onAbort: () => Promise<void>;
  // Manual file selection props
  manualFiles: string[];
  onAddManualFile: (filePath: string) => void;
  onRemoveManualFile: (filePath: string) => void;
}

export const SetupWizardLeftPane: React.FC<SetupWizardLeftPaneProps> = ({
  isNewMode,
  repository,
  repos = [],
  selectedRepo = '',
  selectedBaseBranch = '',
  configuredBaseBranch,
  onRepoChange,
  reposLoading = false,
  baseBranch,
  isRepoLoading,
  branchError,
  repoError,
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
  generationTrace,
  onAbort,
  manualFiles,
  onAddManualFile,
  onRemoveManualFile,
}) => (
  <div className="w-full md:w-[65%] h-auto md:h-full flex flex-col">
    {/* Header with repo/branch - Toolbar border for alignment with right pane */}
    <div className="px-4 py-2 md:px-6 md:py-3 border-b border-gray-300">
      <div className="flex items-center gap-1.5 sm:gap-2 text-sm">
        {isNewMode ? (
          <NewModeHeader
            reposLoading={reposLoading}
            selectedRepo={selectedRepo}
            selectedBaseBranch={selectedBaseBranch}
            repos={repos}
            onRepoChange={onRepoChange}
            baseBranch={baseBranch}
            isLoadingBranches={isRepoLoading}
            branchError={repoError}
          />
        ) : (
          <EditModeHeader
            repository={repository}
            isRepoLoading={isRepoLoading}
            baseBranch={baseBranch}
            selectedBaseBranch={selectedBaseBranch}
            configuredBaseBranch={configuredBaseBranch}
            branchError={branchError}
            repoError={repoError}
            repos={repos}
            onRepoChange={onRepoChange || (() => {})}
            reposLoading={reposLoading}
          />
        )}
      </div>
    </div>

    {/* Main content area */}
    <div className="flex-1 flex flex-col min-h-0">
      {/* Borderless textarea - white canvas stands on its own with gray Header/Footer framing */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onInput={autoResize}
          onPaste={onPaste}
          disabled={isGenerating || isUploading}
          placeholder="Describe the feature, bug fix, or improvement you want to implement..."
          className={`flex-1 w-full text-base text-gray-900 placeholder-gray-400 resize-none leading-relaxed p-4 pb-16 focus:outline-none min-h-[320px] md:min-h-[160px] ${
            isGenerating || isUploading ? 'opacity-70 cursor-not-allowed bg-gray-50' : ''
          }`}
        />
        <div className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-white border-t border-gray-100">
          <div className="flex flex-col gap-3">
            <AttachmentsSection
              isNewMode={isNewMode}
              localFiles={localFiles}
              files={files}
              draftId={draftId}
              onRemoveLocalFile={onRemoveLocalFile}
              onRemoveFile={onRemoveFile}
              isUploading={isUploading}
              isGenerating={isGenerating}
              fileInputRef={fileInputRef}
              onFileInputChange={onFileInputChange}
            />
            <ManualFileSelector
              manualFiles={manualFiles}
              onAddFile={onAddManualFile}
              onRemoveFile={onRemoveManualFile}
              disabled={isGenerating || isUploading}
            />
          </div>
        </div>
      </div>
    </div>

    {/* Error display - above footer */}
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
  </div>
);
