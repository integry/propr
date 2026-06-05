import React from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';
import { useAgentsLoader } from './setupWizardHooks';

// Generate button content - extracted to reduce cyclomatic complexity
export const GenerateButtonContent: React.FC<{
  isNewMode: boolean;
  isCreating: boolean;
  isGenerating: boolean;
  issueCountText: string;
}> = ({ isNewMode, isCreating, isGenerating, issueCountText }) => {
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
      <span>Generate Plan ({issueCountText})</span>
    </>
  );
};

// Model selector component - extracted to reduce cyclomatic complexity
export const ModelSelector: React.FC<{
  agents: ReturnType<typeof useAgentsLoader>;
  generationModel: string | null;
  onModelChange: (value: string | null) => void;
  modelName?: string;
  disabled?: boolean;
}> = ({ agents, generationModel, onModelChange, modelName, disabled }) => {
  const enabledAgents = agents.filter(agent => agent.enabled);

  if (enabledAgents.length === 0) {
    return null;
  }

  const selectedAgent = generationModel?.includes(':')
    ? generationModel.split(':')[0]
    : generationModel;

  const modelOptions = enabledAgents.flatMap(agent =>
    (agent.supportedModels || []).map(modelId => ({
      value: `${agent.alias}:${modelId}`,
      label: `${agent.alias} / ${MODEL_INFO_MAP[modelId]?.name || modelId}`,
      agent: agent.alias
    }))
  );

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onModelChange(e.target.value || null);
  };

  return (
    <div className={`flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm min-w-0 flex-1 sm:flex-initial ${disabled ? 'text-gray-400' : 'text-gray-600'}`}>
      <span className={`${disabled ? 'text-gray-400' : 'text-gray-500'} hidden sm:inline`}>Model:</span>
      <div className="relative inline-flex items-center flex-1 sm:flex-initial max-w-[180px] sm:max-w-[200px]">
        {selectedAgent && (
          <ProviderLogo
            provider={selectedAgent}
            className={`w-4 h-4 absolute left-2 pointer-events-none z-10 ${disabled ? 'opacity-40 grayscale' : ''}`}
          />
        )}
        <select
          value={generationModel || ''}
          onChange={handleChange}
          disabled={disabled}
          className={`appearance-none border rounded-md text-xs sm:text-sm py-1 sm:py-1.5 pr-6 sm:pr-7 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors truncate w-full disabled:bg-gray-100 disabled:border-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed disabled:pointer-events-none ${disabled ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed pointer-events-none' : 'bg-white border-gray-200 text-gray-700 hover:border-gray-300 cursor-pointer'} ${selectedAgent ? 'pl-7' : 'pl-2'}`}
          title={disabled ? 'Model is locked while plan generation is running' : 'Select AI model for plan generation'}
        >
          <option value="">{modelName ? `${modelName}` : 'Default'}</option>
          {modelOptions.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown className={`w-3.5 h-3.5 sm:w-4 sm:h-4 absolute right-1.5 sm:right-2 pointer-events-none ${disabled ? 'text-gray-300' : 'text-gray-400'}`} />
      </div>
    </div>
  );
};
