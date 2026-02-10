import React, { useMemo, useCallback } from 'react';
import { Download, Loader2, ChevronDown } from 'lucide-react';
import { AgentConfig, SmartFileSelection as SmartFileInfo } from '../../api/gitfixApi';
import { ContextLevelSlider } from './ContextLevelSlider';
import { SmartFileSelection } from './SmartFileSelection';
import { FileSelectionSkeleton } from './SkeletonLoader';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

interface PreviewStats {
  totalTokens?: number;
  costEstimate?: number;
  modelName?: string;
  modelMaxContextTokens?: number;
}

interface SetupWizardRightPaneProps {
  contextLevel: number;
  onContextLevelChange: (level: number) => void;
  /** @deprecated Hidden for now - will be polished later */
  compress?: boolean;
  /** @deprecated Hidden for now - will be polished later */
  onCompressChange?: (compress: boolean) => void;
  agents: AgentConfig[];
  generationModel: string | null;
  onGenerationModelChange: (model: string | null) => void;
  smartSelection: SmartFileInfo[] | undefined;
  isPreviewLoading: boolean;
  stats: PreviewStats | undefined;
  isExporting: boolean;
  canExport: boolean;
  onExport: () => void;
}

export const SetupWizardRightPane: React.FC<SetupWizardRightPaneProps> = ({
  contextLevel,
  onContextLevelChange,
  agents,
  generationModel,
  onGenerationModelChange,
  smartSelection,
  isPreviewLoading,
  stats,
  isExporting,
  canExport,
  onExport,
}) => {
  // Get enabled agents only
  const enabledAgents = useMemo(() =>
    agents.filter(agent => agent.enabled),
    [agents]
  );

  // Parse the generationModel string to extract agent
  const selectedAgent = useMemo(() => {
    if (!generationModel) return null;
    if (generationModel.includes(':')) {
      const [agent] = generationModel.split(':');
      return agent;
    }
    return generationModel;
  }, [generationModel]);

  // Build combined options: "agent:model" pairs
  const modelOptions = useMemo(() => {
    const options: { value: string; label: string; agent: string }[] = [];
    for (const agent of enabledAgents) {
      const models = agent.supportedModels || [];
      for (const modelId of models) {
        const modelInfo = MODEL_INFO_MAP[modelId];
        const modelLabel = modelInfo?.name || modelId;
        options.push({
          value: `${agent.alias}:${modelId}`,
          label: `${agent.alias} / ${modelLabel}`,
          agent: agent.alias
        });
      }
    }
    return options;
  }, [enabledAgents]);

  // Handle combined model selection change
  const handleModelSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newValue = e.target.value || null;
    onGenerationModelChange?.(newValue);
  }, [onGenerationModelChange]);

  return (
    <div className="w-[35%] h-full flex flex-col bg-white">
      {/* Context Level Slider - without model selector */}
      <div className="p-5 border-b border-gray-100">
        <ContextLevelSlider
          value={contextLevel}
          onChange={onContextLevelChange}
        />
      </div>

      {/* Smart file selection - extends to fill space between slider and footer */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
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

      {/* Right Footer - Model selector + Export button */}
      <div className="border-t border-gray-100 bg-white px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          {/* Model Selection - minimalist style */}
          {enabledAgents.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-gray-600 min-w-0">
              <span className="text-gray-500 flex-shrink-0">Model:</span>
              <div className="relative inline-flex items-center min-w-0 max-w-[200px]">
                {selectedAgent && (
                  <ProviderLogo
                    provider={selectedAgent}
                    className="w-4 h-4 absolute left-2 pointer-events-none z-10"
                  />
                )}
                <select
                  value={generationModel || ''}
                  onChange={handleModelSelectChange}
                  className={`appearance-none bg-white border border-gray-200 rounded-md text-sm py-1.5 pr-7 text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors truncate w-full ${selectedAgent ? 'pl-7' : 'pl-2.5'}`}
                  title="Select AI model for plan generation"
                >
                  <option value="">{stats?.modelName ? `${stats.modelName} (default)` : 'Default model'}</option>
                  {modelOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-4 h-4 text-gray-400 absolute right-2 pointer-events-none" />
              </div>
            </div>
          )}

          {/* Export Button - ghost/secondary style */}
          <button
            onClick={onExport}
            disabled={isExporting || isPreviewLoading || !canExport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm flex-shrink-0"
            title="Export context as XML"
          >
            {isExporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span>Export Context</span>
          </button>
        </div>
      </div>
    </div>
  );
};
