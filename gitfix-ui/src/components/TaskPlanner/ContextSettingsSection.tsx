import React, { useMemo, useCallback } from 'react';
import { Settings2, Cpu } from 'lucide-react';
import { ContextLevelSlider } from './ContextLevelSlider';
import { AgentModelSelector } from './AgentModelSelector';
import { AgentConfig } from '../../api/gitfixApi';

interface ContextSettingsSectionProps {
  contextLevel: number;
  compress: boolean;
  onContextLevelChange: (level: number) => void;
  onCompressChange: (compress: boolean) => void;
  /** Name of the model used for context limits */
  modelName?: string;
  /** Full context window size of the model in tokens */
  modelMaxContextTokens?: number;
  /** Available agents for model selection */
  agents: AgentConfig[];
  /** Currently selected generation model (format: "agent:modelId" or null for default) */
  generationModel: string | null;
  /** Callback when generation model changes */
  onGenerationModelChange: (model: string | null) => void;
}

export const ContextSettingsSection: React.FC<ContextSettingsSectionProps> = ({
  contextLevel,
  compress,
  onContextLevelChange,
  onCompressChange,
  modelName,
  modelMaxContextTokens,
  agents,
  generationModel,
  onGenerationModelChange
}) => {
  // Parse the generationModel string to extract agent and model
  const { selectedAgent, selectedModel } = useMemo(() => {
    if (!generationModel) return { selectedAgent: null, selectedModel: null };
    if (generationModel.includes(':')) {
      const [agent, model] = generationModel.split(':');
      return { selectedAgent: agent, selectedModel: model };
    }
    // If no colon, it's just an agent alias (use default model)
    return { selectedAgent: generationModel, selectedModel: null };
  }, [generationModel]);

  // Handle agent change - construct the combined model string
  const handleAgentChange = useCallback((agentAlias: string | null) => {
    if (!agentAlias) {
      onGenerationModelChange(null);
      return;
    }
    // Find the agent to get its default model
    const agent = agents.find(a => a.alias === agentAlias);
    if (agent?.defaultModel) {
      onGenerationModelChange(`${agentAlias}:${agent.defaultModel}`);
    } else if (agent?.supportedModels?.length) {
      onGenerationModelChange(`${agentAlias}:${agent.supportedModels[0]}`);
    } else {
      onGenerationModelChange(agentAlias);
    }
  }, [agents, onGenerationModelChange]);

  // Handle model change - update just the model part
  const handleModelChange = useCallback((modelId: string | null) => {
    if (!selectedAgent) return;
    if (modelId) {
      onGenerationModelChange(`${selectedAgent}:${modelId}`);
    } else {
      onGenerationModelChange(selectedAgent);
    }
  }, [selectedAgent, onGenerationModelChange]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-gray-700">
        <Settings2 className="w-5 h-5" />
        <h3 className="font-semibold">Context Settings</h3>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 border border-gray-100 space-y-5">
        {/* AI Model Selection */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-gray-600">
            <Cpu className="w-4 h-4" />
            <span className="text-sm font-medium">AI Model</span>
            <span className="text-xs text-gray-400">(optional)</span>
          </div>
          <div className="flex items-center gap-2">
            <AgentModelSelector
              agents={agents}
              selectedAgent={selectedAgent}
              selectedModel={selectedModel}
              onAgentChange={handleAgentChange}
              onModelChange={handleModelChange}
            />
            {!generationModel && (
              <span className="text-xs text-gray-500 italic">Using global default</span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            Override the global AI model for this plan. Leave empty to use your configured default.
          </p>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-200" />

        {/* Context Level Slider */}
        <ContextLevelSlider
          value={contextLevel}
          onChange={onContextLevelChange}
          compress={compress}
          onCompressChange={onCompressChange}
          modelName={modelName}
          modelMaxContextTokens={modelMaxContextTokens}
        />
      </div>
    </div>
  );
};
