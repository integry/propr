import React from 'react';
import { Settings2 } from 'lucide-react';
import { ContextLevelSlider } from './ContextLevelSlider';

interface ContextSettingsSectionProps {
  contextLevel: number;
  compress: boolean;
  onContextLevelChange: (level: number) => void;
  onCompressChange: (compress: boolean) => void;
  /** Name of the model used for context limits */
  modelName?: string;
  /** Full context window size of the model in tokens */
  modelMaxContextTokens?: number;
}

export const ContextSettingsSection: React.FC<ContextSettingsSectionProps> = ({
  contextLevel,
  compress,
  onContextLevelChange,
  onCompressChange,
  modelName,
  modelMaxContextTokens
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-gray-700">
        <Settings2 className="w-5 h-5" />
        <h3 className="font-semibold">Context Settings</h3>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 border border-gray-100">
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
