import React from 'react';
import { Settings2 } from 'lucide-react';
import { Granularity } from '../../api/gitfixApi';
import { GranularitySelector } from './GranularitySelector';
import { ContextLevelSlider } from './ContextLevelSlider';

interface ContextSettingsSectionProps {
  granularity: Granularity;
  contextLevel: number;
  compress: boolean;
  onGranularityChange: (granularity: Granularity) => void;
  onContextLevelChange: (level: number) => void;
  onCompressChange: (compress: boolean) => void;
}

export const ContextSettingsSection: React.FC<ContextSettingsSectionProps> = ({
  granularity,
  contextLevel,
  compress,
  onGranularityChange,
  onContextLevelChange,
  onCompressChange
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-gray-700">
        <Settings2 className="w-5 h-5" />
        <h3 className="font-semibold">Context Settings</h3>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 space-y-5 border border-gray-100">
        <GranularitySelector
          value={granularity}
          onChange={onGranularityChange}
        />

        <div className="border-t border-gray-200 pt-5">
          <ContextLevelSlider
            value={contextLevel}
            onChange={onContextLevelChange}
            compress={compress}
            onCompressChange={onCompressChange}
          />
        </div>
      </div>
    </div>
  );
};
