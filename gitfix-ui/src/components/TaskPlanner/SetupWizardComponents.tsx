import React from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';
import { Granularity } from '../../api/gitfixApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';
import { useAgentsLoader } from './setupWizardHooks';

export const getEstimatedIssueText = (granularity: Granularity): string => {
  const counts: Record<Granularity, string> = { single: '1', balanced: '3-5', granular: '5-10' };
  const count = counts[granularity] || '1';
  return `${count} ${count === '1' ? 'issue' : 'issues'}`;
};

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
}> = ({ agents, generationModel, onModelChange, modelName }) => {
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
    <div className="flex items-center gap-2 text-sm text-gray-600">
      <span className="text-gray-500">Model:</span>
      <div className="relative inline-flex items-center max-w-[200px]">
        {selectedAgent && (
          <ProviderLogo
            provider={selectedAgent}
            className="w-4 h-4 absolute left-2 pointer-events-none z-10"
          />
        )}
        <select
          value={generationModel || ''}
          onChange={handleChange}
          className={`appearance-none bg-white border border-gray-200 rounded-md text-sm py-1.5 pr-7 text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer transition-colors truncate w-full ${selectedAgent ? 'pl-7' : 'pl-2.5'}`}
          title="Select AI model for plan generation"
        >
          <option value="">{modelName ? `${modelName} (default)` : 'Default model'}</option>
          {modelOptions.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown className="w-4 h-4 text-gray-400 absolute right-2 pointer-events-none" />
      </div>
    </div>
  );
};
