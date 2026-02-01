import React from 'react';
import { PlannerAttachment, PreviewResult, ContextRepository, Granularity, GenerationTrace } from '../../api/gitfixApi';
import { GenerationProgress } from './GenerationProgress';
import { SmartFileSelection } from './SmartFileSelection';
import { FileSelectionSkeleton } from './SkeletonLoader';
import { HeroPromptArea } from './HeroPromptArea';
import { TaskGranularitySection } from './TaskGranularitySection';
import { ContextSettingsSection } from './ContextSettingsSection';
import { ContextRepositoriesSection, IndexedRepository } from './ContextRepositoriesSection';
import { CostPreview } from './CostPreview';
import { ContextRefreshIndicator } from './ContextRefreshIndicator';

interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

interface SetupWizardContentProps {
  // Prompt area props
  prompt: string;
  files: PlannerAttachment[];
  draftId: string;
  isUploading: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onPromptChange: (prompt: string) => void;
  onInput: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onUpload: (file: File) => Promise<void>;
  onRemoveFile: (attachmentId: string) => Promise<void>;

  // Granularity props
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;

  // Context settings props
  contextLevel: number;
  compress: boolean;
  onContextLevelChange: (contextLevel: number) => void;
  onCompressChange: (compress: boolean) => void;

  // Context repositories props
  contextRepositories: ContextRepository[];
  availableRepos: IndexedRepository[];
  onAddContextRepo: (repo: ContextRepository) => void;
  onRemoveContextRepo: (repository: string) => void;

  // Preview and state props
  preview: PreviewState;
  isContextStale: boolean;
  timeUntilRefresh: number | null;
  onManualRefresh: () => void;

  // Error and generation props
  error: string | null;
  generationError: string | null;
  isGenerating: boolean;
  generationTrace?: GenerationTrace;
}

export const SetupWizardContent: React.FC<SetupWizardContentProps> = ({
  prompt,
  files,
  draftId,
  isUploading,
  textareaRef,
  onPromptChange,
  onInput,
  onPaste,
  onUpload,
  onRemoveFile,
  granularity,
  onGranularityChange,
  contextLevel,
  compress,
  onContextLevelChange,
  onCompressChange,
  contextRepositories,
  availableRepos,
  onAddContextRepo,
  onRemoveContextRepo,
  preview,
  isContextStale,
  timeUntilRefresh,
  onManualRefresh,
  error,
  generationError,
  isGenerating,
  generationTrace
}) => {
  return (
    <div className="p-6 space-y-6">
      {/* Hero Prompt Area */}
      <HeroPromptArea
        prompt={prompt}
        files={files}
        draftId={draftId}
        isUploading={isUploading}
        textareaRef={textareaRef}
        onPromptChange={onPromptChange}
        onInput={onInput}
        onPaste={onPaste}
        onUpload={onUpload}
        onRemoveFile={onRemoveFile}
      />

      {/* Task Granularity Section - now separate from Context Settings */}
      <TaskGranularitySection
        granularity={granularity}
        onGranularityChange={onGranularityChange}
      />

      {/* Context Settings Section */}
      <ContextSettingsSection
        contextLevel={contextLevel}
        compress={compress}
        onContextLevelChange={onContextLevelChange}
        onCompressChange={onCompressChange}
        modelName={preview.data?.stats.modelName}
        modelMaxContextTokens={preview.data?.stats.modelMaxContextTokens}
      />

      {/* Context Repositories Section */}
      <ContextRepositoriesSection
        repositories={contextRepositories}
        availableRepos={availableRepos}
        onAdd={onAddContextRepo}
        onRemove={onRemoveContextRepo}
      />

      {/* Cost Preview with Refresh Indicator */}
      <div className="relative">
        <CostPreview
          preview={preview}
          contextRepositories={contextRepositories}
        />
        {/* Context Refresh Indicator */}
        <ContextRefreshIndicator
          isContextStale={isContextStale}
          timeUntilRefresh={timeUntilRefresh}
          isLoading={preview.isLoading}
          onManualRefresh={onManualRefresh}
        />
      </div>

      {/* Smart File Selection - with skeleton during loading */}
      {preview.isLoading && !preview.data ? (
        <FileSelectionSkeleton />
      ) : preview.data && (
        <SmartFileSelection smartSelection={preview.data.smartSelection} />
      )}

      {/* Error display */}
      {(error || generationError) && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
          {error || generationError}
        </div>
      )}

      {/* Generation Progress */}
      {isGenerating && <GenerationProgress trace={generationTrace} />}
    </div>
  );
};
