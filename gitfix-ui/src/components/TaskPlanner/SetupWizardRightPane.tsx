import React from 'react';
import { SmartFileSelection as SmartFileInfo } from '../../api/gitfixApi';
import { ContextLevelSlider } from './ContextLevelSlider';
import { SmartFileSelection } from './SmartFileSelection';
import { FileSelectionSkeleton } from './SkeletonLoader';

interface PreviewStats {
  totalTokens?: number;
  costEstimate?: number;
  modelName?: string;
  modelMaxContextTokens?: number;
}

interface SetupWizardRightPaneProps {
  contextLevel: number;
  onContextLevelChange: (level: number) => void;
  smartSelection: SmartFileInfo[] | undefined;
  isPreviewLoading: boolean;
  stats: PreviewStats | undefined;
}

export const SetupWizardRightPane: React.FC<SetupWizardRightPaneProps> = ({
  contextLevel,
  onContextLevelChange,
  smartSelection,
  isPreviewLoading,
  stats,
}) => {
  return (
    <div className="w-[35%] h-full flex flex-col bg-white border-l border-gray-100">
      {/* Context Level Slider */}
      <div className="p-5 border-b border-gray-100">
        <ContextLevelSlider
          value={contextLevel}
          onChange={onContextLevelChange}
        />
      </div>

      {/* Smart file selection - extends to fill remaining space */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {smartSelection && smartSelection.length > 0 ? (
          <SmartFileSelection
            smartSelection={smartSelection}
            totalTokens={stats?.totalTokens}
            costEstimate={stats?.costEstimate}
          />
        ) : (
          <div className="p-5 space-y-4">
            <p className="text-sm text-gray-400 italic">
              Files will be selected after context analysis
            </p>
            {isPreviewLoading && <FileSelectionSkeleton />}
          </div>
        )}
      </div>
    </div>
  );
};
