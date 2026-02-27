import React from 'react';
import { Settings2 } from 'lucide-react';
import { ContextLevelSlider } from './ContextLevelSlider';

interface ContextSettingsSectionProps {
  contextLevel: number;
  /** @deprecated Hidden for now - will be polished later */
  compress?: boolean;
  onContextLevelChange: (level: number) => void;
  /** @deprecated Hidden for now - will be polished later */
  onCompressChange?: (compress: boolean) => void;
}

export const ContextSettingsSection: React.FC<ContextSettingsSectionProps> = ({
  contextLevel,
  onContextLevelChange,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-gray-700">
        <Settings2 className="w-5 h-5" />
        <h3 className="font-semibold">Context Settings</h3>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 border border-gray-100 space-y-5">
        {/* Context Level Slider */}
        {/* Note: compress and onCompressChange props are kept in the interface but not passed to slider - feature hidden for now */}
        <ContextLevelSlider
          value={contextLevel}
          onChange={onContextLevelChange}
        />
      </div>
    </div>
  );
};
