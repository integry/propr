import React, { useCallback } from 'react';
import { Layers, Zap, Clock, Turtle, DollarSign, BarChart2, Target } from 'lucide-react';

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

// Context level configuration with monotone icons
interface ContextLevelConfig {
  label: string;
  subtitle: string;
  indicatorLine: string;
  speedIcon: React.ComponentType<{ className?: string }>;
  costText: string;
  precisionIcon: React.ComponentType<{ className?: string }>;
}

const LEVEL_CONFIGS: Record<LevelType, ContextLevelConfig> = {
  standard: {
    label: 'Standard',
    subtitle: 'Prioritizes speed and cost. Best for simple features.',
    indicatorLine: 'Fast • $ • Standard',
    speedIcon: Zap,
    costText: '$',
    precisionIcon: BarChart2,
  },
  comprehensive: {
    label: 'Comprehensive',
    subtitle: 'Balanced approach. Good for most development tasks.',
    indicatorLine: 'Moderate • $$ • High Precision',
    speedIcon: Clock,
    costText: '$$',
    precisionIcon: BarChart2,
  },
  deepdive: {
    label: 'Deep Dive',
    subtitle: 'Prioritizes accuracy and edge-cases. Best for complex refactors.',
    indicatorLine: 'Slower • $$$ • Precision',
    speedIcon: Turtle,
    costText: '$$$',
    precisionIcon: Target,
  },
};

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange }) => {
  // Get the current level type and config
  const levelType = getLevelType(value);
  const config = LEVEL_CONFIGS[levelType];
  const SpeedIcon = config.speedIcon;
  const PrecisionIcon = config.precisionIcon;

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
      {/* Header Row: Title on left, compact status line on right */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-gray-500" />
          <label className="text-sm font-medium text-gray-700">
            Context Level
          </label>
        </div>
        {/* Single line indicator with color-coded icons based on temperature scale */}
        <div className={`flex items-center gap-2 text-xs ${levelType === 'standard' ? 'text-sky-500' : levelType === 'comprehensive' ? 'text-amber-500' : 'text-orange-500'}`}>
          <SpeedIcon className="w-3.5 h-3.5 mr-1" />
          <span>{levelType === 'standard' ? 'Fast' : levelType === 'comprehensive' ? 'Moderate' : 'Slower'}</span>
          <span className="text-gray-400">•</span>
          <DollarSign className="w-3.5 h-3.5 mr-1" />
          <span>{config.costText}</span>
          <span className="text-gray-400">•</span>
          <PrecisionIcon className="w-3.5 h-3.5 mr-1" />
          <span>{levelType === 'standard' ? 'Standard' : levelType === 'comprehensive' ? 'High Precision' : 'Precision'}</span>
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
            className={`transition-colors text-left ${levelType === 'standard' ? 'text-sky-500 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Standard
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(50)}
            className={`transition-colors text-center ${levelType === 'comprehensive' ? 'text-amber-500 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Comprehensive
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(90)}
            className={`transition-colors text-right ${levelType === 'deepdive' ? 'text-orange-500 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Deep Dive
          </button>
        </div>
      </div>

      {/* Dynamic Subtitle */}
      <p className="text-xs text-gray-600 italic">
        {config.subtitle}
      </p>
    </div>
  );
};
