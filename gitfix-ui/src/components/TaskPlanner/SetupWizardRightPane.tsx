import React from 'react';
import { AgentConfig, SmartFileSelection as SmartFileInfo } from '../../api/gitfixApi';
import { ContextLevelSlider } from './ContextLevelSlider';

interface PreviewStats {
  totalTokens?: number;
  costEstimate?: number;
  modelName?: string;
  modelMaxContextTokens?: number;
}

interface SetupWizardRightPaneProps {
  isNewMode?: boolean;
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
  isNewMode = false,
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

      {/* Selected files / Cost preview area */}
      <div className="flex-1 overflow-auto p-5">
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-gray-700">
            Selected Files ({isNewMode ? 0 : (smartSelection?.length || 0)})
          </h3>
          {isNewMode ? (
            <p className="text-sm text-gray-400 italic">
              Files will be selected after context analysis
            </p>
          ) : isPreviewLoading ? (
            <p className="text-sm text-gray-400 italic">Analyzing context...</p>
          ) : smartSelection?.length ? (
            <div className="text-sm text-gray-600 space-y-1 max-h-64 overflow-auto">
              {smartSelection.slice(0, 10).map((file, i) => (
                <div key={i} className="truncate text-xs text-gray-500">{file.path}</div>
              ))}
              {smartSelection.length > 10 && (
                <div className="text-xs text-gray-400 italic">
                  +{smartSelection.length - 10} more files
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">
              Enter a prompt to analyze relevant files
            </p>
          )}
        </div>
      </div>

      {/* Cost estimate footer */}
      <div className="border-t border-gray-100 px-5 py-4 bg-white">
        <div className="flex items-center justify-between text-sm">
          <div className="text-gray-500">
            <span className="font-medium text-gray-700">
              {isNewMode ? '42' : (stats?.totalTokens
                ? (stats.totalTokens / 1000).toFixed(0)
                : '0')}k
            </span>{' '}
            tokens
          </div>
          <div className="text-gray-600">
            Est:{' '}
            <span className="font-semibold text-gray-900">
              ${isNewMode ? '0.79' : (stats?.costEstimate?.toFixed(2) || '0.00')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
