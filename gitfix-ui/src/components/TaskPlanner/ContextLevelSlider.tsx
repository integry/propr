import React, { useCallback } from 'react';
import { Layers, Minimize2 } from 'lucide-react';

interface ContextLevelSliderProps {
  value: number;
  onChange: (level: number) => void;
  compress?: boolean;
  onCompressChange?: (compress: boolean) => void;
}

// Level thresholds for determining which config to use
type LevelType = 'standard' | 'comprehensive' | 'deepdive';

// Get the level type from a value (0-100)
const getLevelType = (value: number): LevelType => {
  if (value <= 35) return 'standard';
  if (value <= 70) return 'comprehensive';
  return 'deepdive';
};

// Context level configuration with all dynamic indicators
interface ContextLevelConfig {
  label: string;
  subtitle: string;
  speed: { icon: string; text: string };
  cost: { icon: string; text: string };
  precision: { icon: string; text: string };
}

const LEVEL_CONFIGS: Record<LevelType, ContextLevelConfig> = {
  standard: {
    label: 'Standard',
    subtitle: 'Prioritizes speed and cost. Best for simple features.',
    speed: { icon: '⚡', text: 'Fast' },
    cost: { icon: '🟢', text: '$' },
    precision: { icon: '📉', text: 'Std Precision' },
  },
  comprehensive: {
    label: 'Comprehensive',
    subtitle: 'Balanced approach. Good for most development tasks.',
    speed: { icon: '🕓', text: 'Moderate' },
    cost: { icon: '🟡', text: '$$' },
    precision: { icon: '📊', text: 'High Precision' },
  },
  deepdive: {
    label: 'Deep Dive',
    subtitle: 'Prioritizes accuracy and edge-cases. Best for complex refactors.',
    speed: { icon: '🐌', text: 'Slower' },
    cost: { icon: '🔴', text: '$$$' },
    precision: { icon: '🎯', text: 'Max Precision' },
  },
};

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange, compress = false, onCompressChange }) => {
  // Get the current level type and config
  const levelType = getLevelType(value);
  const config = LEVEL_CONFIGS[levelType];

  // Handle slider change - no snapping, moves at 10% increments
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = Number(e.target.value);
    onChange(rawValue);
  }, [onChange]);

  // Handle direct label clicks (convenience shortcuts)
  const handleLabelClick = useCallback((targetValue: number) => {
    onChange(targetValue);
  }, [onChange]);

  return (
    <div className="space-y-4">
      {/* Header Row: Title on left, compact status metrics on right */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-gray-500" />
          <label className="text-sm font-medium text-gray-700">
            Context Level
          </label>
        </div>
        {/* Compact Status Row - updates live based on slider position */}
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span>{config.speed.icon}</span>
          <span>{config.speed.text}</span>
          <span className="text-gray-400 mx-1">•</span>
          <span>{config.cost.icon}</span>
          <span>{config.cost.text}</span>
          <span className="text-gray-400 mx-1">•</span>
          <span>{config.precision.icon}</span>
          <span>{config.precision.text}</span>
        </div>
      </div>

      {/* Slider with Gradient Track */}
      <div className="space-y-2">
        <input
          type="range"
          min={0}
          max={100}
          step={10}
          value={value}
          onChange={handleSliderChange}
          className="context-slider w-full h-2 rounded-lg cursor-pointer"
        />
        <div className="flex justify-between text-xs">
          <button
            type="button"
            onClick={() => handleLabelClick(20)}
            className={`transition-colors ${levelType === 'standard' ? 'text-green-600 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Standard
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(50)}
            className={`transition-colors ${levelType === 'comprehensive' ? 'text-blue-600 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Comprehensive
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(90)}
            className={`transition-colors ${levelType === 'deepdive' ? 'text-purple-600 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Deep Dive
          </button>
        </div>
      </div>

      {/* Dynamic Subtitle */}
      <p className="text-xs text-gray-600 italic">
        {config.subtitle}
      </p>

      {onCompressChange && (
        <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors">
          <input
            type="checkbox"
            checked={compress}
            onChange={(e) => onCompressChange(e.target.checked)}
            className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
          />
          <div className="flex items-center gap-2 flex-1">
            <Minimize2 className="w-4 h-4 text-gray-500" />
            <div>
              <span className="text-sm font-medium text-gray-700">Compress context</span>
              <p className="text-xs text-gray-500">
                Remove comments and whitespace to fit more files
              </p>
            </div>
          </div>
        </label>
      )}
    </div>
  );
};
