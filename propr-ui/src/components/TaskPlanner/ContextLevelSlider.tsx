import React, { useCallback } from 'react';
import { Layers, Zap, Clock, Turtle, DollarSign, BarChart2, Target } from 'lucide-react';

interface ContextLevelSliderProps {
  value: number;
  onChange: (level: number) => void;
  compress?: boolean;
  onCompressChange?: (compress: boolean) => void;
}

// Level thresholds for determining which config to use
type LevelType = 'focused' | 'expanded' | 'fullscan';

// Get the level type from a value (0-100)
const getLevelType = (value: number): LevelType => {
  if (value <= 35) return 'focused';
  if (value <= 70) return 'expanded';
  return 'fullscan';
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
  focused: {
    label: 'Focused',
    subtitle: 'Analyzes only directly referenced files. Best for isolated bug fixes and simple tweaks.',
    indicatorLine: 'Fast • $ • Standard',
    speedIcon: Zap,
    costText: '$',
    precisionIcon: BarChart2,
  },
  expanded: {
    label: 'Expanded',
    subtitle: 'Analyzes imports, dependencies, and related modules. Best for adding new features or updating logic.',
    indicatorLine: 'Moderate • $$ • High Precision',
    speedIcon: Clock,
    costText: '$$',
    precisionIcon: BarChart2,
  },
  fullscan: {
    label: 'Full Scan',
    subtitle: 'Scans the entire repository structure to catch edge cases. Essential for refactoring and architectural changes.',
    indicatorLine: 'Slower • $$$ • Max Precision',
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
            Context Scope
          </label>
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${levelType === 'focused' ? 'bg-sky-100 text-sky-600' : levelType === 'expanded' ? 'bg-blue-100 text-blue-600' : 'bg-indigo-100 text-indigo-600'}`}>
            {value}%
          </span>
        </div>
        {/* Single line indicator with monotone icons - Ocean Depth color scale */}
        <div className={`flex items-center gap-2 text-xs ${levelType === 'focused' ? 'text-sky-400' : levelType === 'expanded' ? 'text-blue-500' : 'text-indigo-600'}`}>
          <SpeedIcon className="w-3.5 h-3.5 mr-1 text-gray-500" />
          <span>{levelType === 'focused' ? 'Fast' : levelType === 'expanded' ? 'Moderate' : 'Slower'}</span>
          <span className="text-gray-400">•</span>
          <DollarSign className="w-3.5 h-3.5 mr-1 text-gray-500" />
          <span>{config.costText}</span>
          <span className="text-gray-400">•</span>
          <PrecisionIcon className="w-3.5 h-3.5 mr-1 text-gray-500" />
          <span>{levelType === 'focused' ? 'Standard' : levelType === 'expanded' ? 'High Precision' : 'Max Precision'}</span>
        </div>
      </div>

      {/* Slider with Gradient Track */}
      <div className="space-y-2">
        <input
          type="range"
          min={10}
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
            className={`transition-colors text-left ${levelType === 'focused' ? 'text-sky-400 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Focused
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(50)}
            className={`transition-colors text-center ${levelType === 'expanded' ? 'text-blue-500 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Expanded
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(90)}
            className={`transition-colors text-right ${levelType === 'fullscan' ? 'text-indigo-600 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Full Scan
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
