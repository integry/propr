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
    <div className="h-full flex flex-col">
      {/* Main Content - Full Height Vertical Split */}
      <div className="flex-1 flex min-h-0">
        {/* Left Panel - Prompt Area (60%) */}
        <div className="w-[60%] h-full flex flex-col border-r border-gray-200">
          <div className="flex-1 overflow-auto p-6">
            {/* Hero Prompt Area - full height */}
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
              minHeight="300px"
            />

            {/* Smart File Selection - below prompt */}
            <div className="mt-6">
              {preview.isLoading && !preview.data ? (
                <FileSelectionSkeleton />
              ) : preview.data && (
                <SmartFileSelection smartSelection={preview.data.smartSelection} />
              )}
            </div>
          </div>
        </div>

        {/* Right Panel - Configuration (40%) */}
        <div className="w-[40%] h-full flex flex-col bg-gray-50">
          <div className="flex-1 overflow-auto p-5 space-y-4">
            {/* Settings container */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
              {/* Task Granularity Section */}
              <TaskGranularitySection
                granularity={granularity}
                onGranularityChange={onGranularityChange}
              />

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

              <div className="border-t border-gray-200" />

              {/* Context Repositories Section */}
              <ContextRepositoriesSection
                repositories={contextRepositories}
                availableRepos={availableRepos}
                onAdd={onAddContextRepo}
                onRemove={onRemoveContextRepo}
              />
            </div>

            {/* Cost Preview */}
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
      </div>

      {/* Error display - above footer */}
      {(error || generationError) && (
        <div className="px-6 py-3 bg-red-50 border-t border-red-200 text-red-700">
          {error || generationError}
        </div>
      )}

      {/* Generation Progress - above footer */}
      {isGenerating && (
        <div className="px-6 py-3 border-t border-gray-200">
          <GenerationProgress trace={generationTrace} onAbort={onAbort} />
        </div>
      )}

      {/* Sticky Footer - Always visible */}
      <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 shadow-lg">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <GenerateButton
              isGenerating={isGenerating}
              isRepoLoading={isRepoLoading}
              disabled={isGenerateDisabled}
              onClick={onGenerate}
            />
          </div>
          <ExportContextButton
            isExporting={isExporting}
            isPreviewLoading={isPreviewLoading}
            canExport={canExport}
            onExport={onExport}
          />
        </div>
      </div>
    </div>
  );
};
