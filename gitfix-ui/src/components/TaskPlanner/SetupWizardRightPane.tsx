import React from 'react';
import { AgentConfig, SmartFileSelection as SmartFileInfo } from '../../api/gitfixApi';
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
  compress: boolean;
  onCompressChange: (compress: boolean) => void;
  agents: AgentConfig[];
  generationModel: string | null;
  onGenerationModelChange: (model: string | null) => void;
  smartSelection: SmartFileInfo[] | undefined;
  isPreviewLoading: boolean;
  stats: PreviewStats | undefined;
}

export const SetupWizardRightPane: React.FC<SetupWizardRightPaneProps> = ({
  contextLevel,
  onContextLevelChange,
  compress,
  onCompressChange,
  agents,
  generationModel,
  onGenerationModelChange,
  smartSelection,
  isPreviewLoading,
  stats,
}) => {
  return (
    <div className="w-[35%] h-full flex flex-col bg-white">
      {/* Context Level Slider */}
      <div className="p-5 border-b border-gray-100">
        <ContextLevelSlider
          value={contextLevel}
          onChange={onContextLevelChange}
          compress={compress}
          onCompressChange={onCompressChange}
          agents={agents}
          generationModel={generationModel}
          onGenerationModelChange={onGenerationModelChange}
          modelName={stats?.modelName}
          modelMaxContextTokens={stats?.modelMaxContextTokens}
        />
      </div>

      {/* Smart file selection - extends to bottom */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {isPreviewLoading && !smartSelection?.length ? (
          <div className="p-5">
            <FileSelectionSkeleton />
          </div>
        ) : smartSelection && smartSelection.length > 0 ? (
          <SmartFileSelection
            smartSelection={smartSelection}
            totalTokens={stats?.totalTokens}
            costEstimate={stats?.costEstimate}
          />
        ) : (
          <div className="p-5">
            <p className="text-sm text-gray-400 italic">
              Files will be selected after context analysis
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
