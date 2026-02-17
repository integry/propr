import React from 'react';
import { SmartFileSelection as SmartFileInfo, ContextRepository, GenerationTrace } from '../../api/gitfixApi';
import { ContextLevelSlider } from './ContextLevelSlider';
import { SmartFileSelection } from './SmartFileSelection';
import { FileSelectionSkeleton } from './SkeletonLoader';
import { ContextRepositoriesSection, IndexedRepository } from './ContextRepositoriesSection';
import { CostPreview } from './CostPreview';

interface PreviewStats {
  totalTokens?: number;
  costEstimate?: number;
  modelName?: string;
  modelMaxContextTokens?: number;
}

interface PreviewState {
  isLoading: boolean;
  data: {
    stats: PreviewStats;
    smartSelection: SmartFileInfo[];
    warnings: string[];
  } | null;
  error: string | null;
  lastSynced: Date | null;
}

interface SetupWizardRightPaneProps {
  contextLevel: number;
  onContextLevelChange: (level: number) => void;
  smartSelection: SmartFileInfo[] | undefined;
  isPreviewLoading: boolean;
  stats: PreviewStats | undefined;
  // Context repositories props
  contextRepositories: ContextRepository[];
  availableRepos: IndexedRepository[];
  onAddContextRepo: (repo: ContextRepository) => void;
  onRemoveContextRepo: (repository: string) => void;
  // Context refresh props
  preview: PreviewState;
  isContextStale?: boolean;
  timeUntilRefresh?: number | null;
  isPaused?: boolean;
  onTogglePause?: () => void;
  onManualRefresh?: () => void;
  // Mode indicator
  isNewMode?: boolean;
  // Preview trace for progress display
  previewTrace?: GenerationTrace;
}

export const SetupWizardRightPane: React.FC<SetupWizardRightPaneProps> = ({
  contextLevel,
  onContextLevelChange,
  smartSelection,
  isPreviewLoading,
  stats,
  contextRepositories,
  availableRepos,
  onAddContextRepo,
  onRemoveContextRepo,
  preview,
  isContextStale,
  timeUntilRefresh,
  isPaused,
  onTogglePause,
  onManualRefresh,
  isNewMode,
  previewTrace,
}) => {
  return (
    <div className="w-[35%] h-full flex flex-col bg-white border-l border-gray-300">
      {/* Context Level Slider - Toolbar aligns with left pane header */}
      <div className="p-5 border-b border-gray-300">
        <ContextLevelSlider
          value={contextLevel}
          onChange={onContextLevelChange}
        />
      </div>

      {/* Smart file selection - scrollable area */}
      <div className="flex-1 overflow-auto flex flex-col min-h-0">
        {smartSelection && smartSelection.length > 0 ? (
          <SmartFileSelection
            smartSelection={smartSelection}
            totalTokens={stats?.totalTokens}
            costEstimate={stats?.costEstimate}
          />
        ) : (
          <div className="p-5 space-y-4">
            <p className="text-sm text-gray-400 italic">
              {isNewMode
                ? 'Context preview will be available after clicking Generate'
                : 'Files will be selected after context analysis'}
            </p>
            {isPreviewLoading && <FileSelectionSkeleton />}
          </div>
        )}
      </div>

      {/* Bottom section - Context repositories and Cost preview */}
      <div className="flex-shrink-0 border-t border-gray-300 p-5 space-y-4 bg-gray-50">
        {/* Context Repositories Section */}
        <ContextRepositoriesSection
          repositories={contextRepositories}
          availableRepos={availableRepos}
          onAdd={onAddContextRepo}
          onRemove={onRemoveContextRepo}
        />

        {/* Cost Preview with Refresh Indicator */}
        <CostPreview
          preview={preview}
          contextRepositories={contextRepositories}
          isContextStale={isContextStale}
          timeUntilRefresh={timeUntilRefresh}
          isPaused={isPaused}
          onTogglePause={onTogglePause}
          onManualRefresh={onManualRefresh}
          isNewMode={isNewMode}
          previewTrace={previewTrace}
        />
      </div>
    </div>
  );
};
