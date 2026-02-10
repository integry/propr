import React, { useMemo, useCallback } from 'react';
import { Layers, Minimize2, Cpu, ChevronDown } from 'lucide-react';
import { AgentConfig } from '../../api/gitfixApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

interface ContextLevelSliderProps {
  value: number;
  onChange: (level: number) => void;
  compress?: boolean;
  onCompressChange?: (compress: boolean) => void;
  /** Name of the model used for context limits */
  modelName?: string;
  /** Full context window size of the model in tokens */
  modelMaxContextTokens?: number;
  /** Available agents for model selection */
  agents?: AgentConfig[];
  /** Currently selected generation model (format: "agent:modelId" or null for default) */
  generationModel?: string | null;
  /** Callback when generation model changes */
  onGenerationModelChange?: (model: string | null) => void;
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

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange, compress = false, onCompressChange, modelName, modelMaxContextTokens, agents = [], generationModel, onGenerationModelChange }) => {
  // Get the current level type and config
  const levelType = getLevelType(value);
  const config = LEVEL_CONFIGS[levelType];

  // Get enabled agents only
  const enabledAgents = useMemo(() =>
    agents.filter(agent => agent.enabled),
    [agents]
  );

  // Parse the generationModel string to extract agent
  const selectedAgent = useMemo(() => {
    if (!generationModel) return null;
    if (generationModel.includes(':')) {
      const [agent] = generationModel.split(':');
      return agent;
    }
    return generationModel;
  }, [generationModel]);

  // Build combined options: "agent:model" pairs
  const modelOptions = useMemo(() => {
    const options: { value: string; label: string; agent: string }[] = [];
    for (const agent of enabledAgents) {
      const models = agent.supportedModels || [];
      for (const modelId of models) {
        const modelInfo = MODEL_INFO_MAP[modelId];
        const modelLabel = modelInfo?.name || modelId;
        options.push({
          value: `${agent.alias}:${modelId}`,
          label: `${agent.alias} / ${modelLabel}`,
          agent: agent.alias
        });
      }
    }
    return options;
  }, [enabledAgents]);

  // Handle combined model selection change
  const handleModelSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newValue = e.target.value || null;
    onGenerationModelChange?.(newValue);
  }, [onGenerationModelChange]);

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

      {/* Model selection or display */}
      {enabledAgents.length > 0 && onGenerationModelChange ? (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Cpu className="w-3.5 h-3.5" />
          <div className="relative inline-flex items-center">
            {selectedAgent && (
              <ProviderLogo
                provider={selectedAgent}
                className="w-3.5 h-3.5 absolute left-1.5 pointer-events-none z-10"
              />
            )}
            <select
              value={generationModel || ''}
              onChange={handleModelSelectChange}
              className={`appearance-none bg-transparent border-none text-xs text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-0 cursor-pointer pr-4 ${selectedAgent ? 'pl-6' : 'pl-0'}`}
              title="Select AI model for plan generation"
            >
              <option value="">{modelName ? `${modelName} (default)` : 'Default model'}</option>
              {modelOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-gray-400 -ml-3 pointer-events-none" />
          </div>
          {modelMaxContextTokens && (
            <span className="text-gray-400">
              ({(modelMaxContextTokens / 1000).toFixed(0)}K max)
            </span>
          )}
        </div>
      ) : modelName && modelMaxContextTokens ? (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Cpu className="w-3.5 h-3.5" />
          <span>
            {modelName} ({(modelMaxContextTokens / 1000).toFixed(0)}K max context)
          </span>
        </div>
      ) : null}

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
