import React, { useCallback } from 'react';
import { Layers } from 'lucide-react';
import { DEFAULT_MODEL_MAX_TOKENS, getContextTokenBudget } from '../../hooks/contextRefreshUtils';
import { formatTokenAmount } from './tokenFormat';

interface ContextLevelSliderProps {
  value: number;
  onChange: (level: number) => void;
  compress?: boolean;
  onCompressChange?: (compress: boolean) => void;
  hideCostLabels?: boolean;
  /** The planning model's context window, when the preview has reported it. */
  modelMaxTokens?: number;
}

// Level thresholds for determining which config to use
type LevelType = 'focused' | 'expanded' | 'fullscan';

// Get the level type from a value (0-100)
const getLevelType = (value: number): LevelType => {
  if (value <= 35) return 'focused';
  if (value <= 70) return 'expanded';
  return 'fullscan';
};

// Context level configuration: technical descriptors with approximate latency estimates.
// The token estimate is derived from the model's context window, as the preview's budget is.
interface ContextLevelConfig {
  label: string;
  subtitle: string;
  scanName: string;
  analysis: string;
  costLabel: string;
  latencyEstimate: string;
}

const LEVEL_CONFIGS: Record<LevelType, ContextLevelConfig> = {
  focused: {
    label: 'Focused',
    subtitle: 'Analyzes only directly referenced files. Best for isolated bug fixes and simple tweaks.',
    scanName: 'Targeted File Scan',
    analysis: 'Direct References',
    costLabel: 'Lowest Cost',
    latencyEstimate: '<1m scan',
  },
  expanded: {
    label: 'Expanded',
    subtitle: 'Analyzes imports, dependencies, and related modules. Best for adding new features or updating logic.',
    scanName: 'Dependency Graph Scan',
    analysis: 'Imports & Related Modules',
    costLabel: 'Moderate Cost',
    latencyEstimate: '~1-2m scan',
  },
  fullscan: {
    label: 'Full Scan',
    subtitle: 'Scans the entire repository structure to catch edge cases. Essential for refactoring and architectural changes.',
    scanName: 'Full Repository Scan',
    analysis: 'Deep AST Analysis',
    costLabel: 'Higher Cost',
    latencyEstimate: '~3-5m scan',
  },
};

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange, hideCostLabels, modelMaxTokens }) => {
  // Get the current level type and config
  const levelType = getLevelType(value);
  const config = LEVEL_CONFIGS[levelType];
  const analysisDetail = hideCostLabels ? config.analysis : `${config.analysis} · ${config.costLabel}`;
  const tokenEstimate = `≤${formatTokenAmount(getContextTokenBudget(value, modelMaxTokens || DEFAULT_MODEL_MAX_TOKENS))} tokens`;
  const estimate = hideCostLabels ? config.latencyEstimate : `${tokenEstimate} · ${config.latencyEstimate}`;

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
    <div className="space-y-2 sm:space-y-3">
      {/* Header Row: Title on left, token / latency estimate on right */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Layers className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-gray-500" />
          <label className="text-xs sm:text-sm font-medium text-gray-700">
            Context Scope
          </label>
          <span className="text-xs font-medium tabular-nums px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
            {value}%
          </span>
        </div>
        <span className="text-xs font-mono text-slate-500 whitespace-nowrap" data-testid="context-scope-estimate">
          {estimate}
        </span>
      </div>

      {/* Slider with Gradient Track */}
      <div className="space-y-1">
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

      {/* Scan descriptor and dynamic subtitle */}
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-slate-700" data-testid="context-scope-descriptor">
          {config.scanName} <span className="font-normal text-slate-500">({analysisDetail})</span>
        </p>
        <p className="hidden sm:block text-xs text-slate-500">
          {config.subtitle}
        </p>
      </div>
    </div>
  );
};
