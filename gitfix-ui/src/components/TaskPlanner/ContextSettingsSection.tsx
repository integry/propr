import React from 'react';
import { Settings2 } from 'lucide-react';
import { ContextLevelSlider } from './ContextLevelSlider';
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
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-gray-700">
        <Settings2 className="w-5 h-5" />
        <h3 className="font-semibold">Context Settings</h3>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 border border-gray-100 space-y-5">
        {/* Context Level Slider */}
        <ContextLevelSlider
          value={contextLevel}
          onChange={onContextLevelChange}
          compress={compress}
          onCompressChange={onCompressChange}
          modelName={modelName}
          modelMaxContextTokens={modelMaxContextTokens}
          agents={agents}
          generationModel={generationModel}
          onGenerationModelChange={onGenerationModelChange}
        />
      </div>
    </div>
  );
};
