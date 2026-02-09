import React from 'react';
import { PlannerAttachment, PreviewResult, ContextRepository, Granularity, GenerationTrace, AgentConfig } from '../../api/gitfixApi';
import { GenerationProgress } from './GenerationProgress';
import { SmartFileSelection } from './SmartFileSelection';
import { FileSelectionSkeleton } from './SkeletonLoader';
import { HeroPromptArea } from './HeroPromptArea';
import { TaskGranularitySection } from './TaskGranularitySection';
import { ContextSettingsSection } from './ContextSettingsSection';
import { ContextRepositoriesSection, IndexedRepository } from './ContextRepositoriesSection';
import { CostPreview } from './CostPreview';
import { GenerateButton } from './GenerateButton';
import { ExportContextButton } from './ExportContextButton';

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

  // AI Model selection props
  agents: AgentConfig[];
  generationModel: string | null;
  onGenerationModelChange: (model: string | null) => void;

  // Preview and state props
  preview: PreviewState;
  isContextStale: boolean;
  timeUntilRefresh: number | null;
  isPaused?: boolean;
  onTogglePause?: () => void;
  onManualRefresh: () => void;

  // Error and generation props
  error: string | null;
  generationError: string | null;
  isGenerating: boolean;
  generationTrace?: GenerationTrace;
  onAbort?: () => Promise<void>;

  // Generate button props
  isRepoLoading: boolean;
  isGenerateDisabled: boolean;
  onGenerate: () => void;

  // Export context props
  isExporting: boolean;
  isPreviewLoading: boolean;
  canExport: boolean;
  onExport: () => void;
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
  agents,
  generationModel,
  onGenerationModelChange,
  preview,
  isContextStale,
  timeUntilRefresh,
  isPaused,
  onTogglePause,
  onManualRefresh,
  error,
  generationError,
  isGenerating,
  generationTrace,
  onAbort,
  isRepoLoading,
  isGenerateDisabled,
  onGenerate,
  isExporting,
  isPreviewLoading,
  canExport,
  onExport
}) => {
  return (
    <div className="p-6">
      {/* Split-view layout: Left (prompt) and Right (settings) */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left Column - Prompt Area (col-span-7) */}
        <div className="col-span-12 lg:col-span-7 flex flex-col">
          <div className="flex-1 space-y-4">
            {/* Hero Prompt Area - expanded to fill available height */}
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

            {/* Smart File Selection - with skeleton during loading */}
            <div className="mt-4">
              {preview.isLoading && !preview.data ? (
                <FileSelectionSkeleton />
              ) : preview.data && (
                <SmartFileSelection smartSelection={preview.data.smartSelection} />
              )}
            </div>
          </div>
        </div>

        {/* Right Column - Configuration Panel (col-span-5) */}
        <div className="col-span-12 lg:col-span-5 space-y-4">
          {/* Settings container with card styling */}
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-5 space-y-5">
            {/* Task Granularity Section */}
            <TaskGranularitySection
              granularity={granularity}
              onGranularityChange={onGranularityChange}
            />

            {/* Divider */}
            <div className="border-t border-gray-200" />

            {/* Context Settings Section */}
            <ContextSettingsSection
              contextLevel={contextLevel}
              compress={compress}
              onContextLevelChange={onContextLevelChange}
              onCompressChange={onCompressChange}
              modelName={preview.data?.stats.modelName}
              modelMaxContextTokens={preview.data?.stats.modelMaxContextTokens}
              agents={agents}
              generationModel={generationModel}
              onGenerationModelChange={onGenerationModelChange}
            />

            {/* Divider */}
            <div className="border-t border-gray-200" />

            {/* Context Repositories Section */}
            <ContextRepositoriesSection
              repositories={contextRepositories}
              availableRepos={availableRepos}
              onAdd={onAddContextRepo}
              onRemove={onRemoveContextRepo}
            />
          </div>

          {/* Cost Preview - outside the settings card for emphasis */}
          <CostPreview
            preview={preview}
            contextRepositories={contextRepositories}
            isContextStale={isContextStale}
            timeUntilRefresh={timeUntilRefresh}
            isPaused={isPaused}
            onTogglePause={onTogglePause}
            onManualRefresh={onManualRefresh}
          />
        </div>
      </div>

      {/* Error display - full width */}
      {(error || generationError) && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
          {error || generationError}
        </div>
      )}

      {/* Generation Progress - full width */}
      {isGenerating && (
        <div className="mt-6">
          <GenerationProgress trace={generationTrace} onAbort={onAbort} />
        </div>
      )}

      {/* Action buttons - sticky footer style */}
      <div className="mt-6 pt-4 border-t border-gray-200 space-y-3">
        <GenerateButton
          isGenerating={isGenerating}
          isRepoLoading={isRepoLoading}
          disabled={isGenerateDisabled}
          onClick={onGenerate}
        />
        <ExportContextButton
          isExporting={isExporting}
          isPreviewLoading={isPreviewLoading}
          canExport={canExport}
          onExport={onExport}
        />
      </div>
    </div>
  );
};
