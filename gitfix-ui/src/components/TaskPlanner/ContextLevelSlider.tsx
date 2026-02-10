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

// Snap positions: Standard (20), Comprehensive (50), Deep Dive (90)
const SNAP_POSITIONS = [20, 50, 90] as const;
type SnapPosition = typeof SNAP_POSITIONS[number];

// Get the snap position from a raw value
const getSnapPosition = (value: number): SnapPosition => {
  if (value <= 35) return 20;
  if (value <= 70) return 50;
  return 90;
};

// Context level configuration with all dynamic indicators
interface ContextLevelConfig {
  label: string;
  statusPill: { icon: string; text: string };
  subtitle: string;
  speed: { icon: string; text: string; color: string };
  cost: { icon: string; text: string; color: string };
  precision: { icon: string; text: string; color: string };
}

const LEVEL_CONFIGS: Record<SnapPosition, ContextLevelConfig> = {
  20: {
    label: 'Standard',
    statusPill: { icon: '⚡', text: 'Speed Focus' },
    subtitle: 'Prioritizes speed and cost. Best for simple features.',
    speed: { icon: '⚡', text: 'Fast', color: 'text-green-600' },
    cost: { icon: '🟢', text: '$', color: 'text-green-600' },
    precision: { icon: '📉', text: 'Standard', color: 'text-gray-600' },
  },
  50: {
    label: 'Comprehensive',
    statusPill: { icon: '📊', text: 'Balanced' },
    subtitle: 'Balanced approach. Good for most development tasks.',
    speed: { icon: '🕓', text: 'Moderate', color: 'text-yellow-600' },
    cost: { icon: '🟡', text: '$$', color: 'text-yellow-600' },
    precision: { icon: '📊', text: 'High', color: 'text-blue-600' },
  },
  90: {
    label: 'Deep Dive',
    statusPill: { icon: '🎯', text: 'Precision Focus' },
    subtitle: 'Prioritizes accuracy and edge-cases. Best for complex refactors.',
    speed: { icon: '🐌', text: 'Slower', color: 'text-orange-600' },
    cost: { icon: '🔴', text: '$$$', color: 'text-red-600' },
    precision: { icon: '🎯', text: 'Max', color: 'text-purple-600' },
  },
};

const getStatusPillColor = (position: SnapPosition): string => {
  if (position === 20) return 'bg-green-100 text-green-700 border-green-300';
  if (position === 50) return 'bg-blue-100 text-blue-700 border-blue-300';
  return 'bg-purple-100 text-purple-700 border-purple-300';
};

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange, compress = false, onCompressChange, modelName, modelMaxContextTokens, agents = [], generationModel, onGenerationModelChange }) => {
  // Get the current snap position and config
  const snapPosition = getSnapPosition(value);
  const config = LEVEL_CONFIGS[snapPosition];
  const statusPillColor = getStatusPillColor(snapPosition);

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

  // Handle slider change with snapping
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = Number(e.target.value);
    const snappedPosition = getSnapPosition(rawValue);
    onChange(snappedPosition);
  }, [onChange]);

  // Handle direct label clicks
  const handleLabelClick = useCallback((position: SnapPosition) => {
    onChange(position);
  }, [onChange]);

  return (
    <div className="space-y-4">
      {/* Header Row: Title + Dynamic Status Pill */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-gray-500" />
          <label className="text-sm font-medium text-gray-700">
            Context Level
          </label>
        </div>
        <div className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border ${statusPillColor}`}>
          <span>{config.statusPill.icon}</span>
          <span>{config.statusPill.text}</span>
        </div>
      </div>

      {/* Slider with Gradient Track */}
      <div className="space-y-2">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={snapPosition}
          onChange={handleSliderChange}
          className="context-slider w-full h-2 rounded-lg cursor-pointer"
        />
        <div className="flex justify-between text-xs">
          <button
            type="button"
            onClick={() => handleLabelClick(20)}
            className={`transition-colors ${snapPosition === 20 ? 'text-green-600 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Standard
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(50)}
            className={`transition-colors ${snapPosition === 50 ? 'text-blue-600 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Comprehensive
          </button>
          <button
            type="button"
            onClick={() => handleLabelClick(90)}
            className={`transition-colors ${snapPosition === 90 ? 'text-purple-600 font-medium' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Deep Dive
          </button>
        </div>
      </div>

      {/* Dynamic Subtitle */}
      <p className="text-xs text-gray-600 italic">
        {config.subtitle}
      </p>

      {/* Impact Summary: Speed | Cost | Precision */}
      <div className="grid grid-cols-3 gap-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex flex-col items-center text-center">
          <span className="text-lg">{config.speed.icon}</span>
          <span className={`text-xs font-medium ${config.speed.color}`}>{config.speed.text}</span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wide">Speed</span>
        </div>
        <div className="flex flex-col items-center text-center border-x border-gray-200">
          <span className="text-lg">{config.cost.icon}</span>
          <span className={`text-xs font-medium ${config.cost.color}`}>{config.cost.text}</span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wide">Cost</span>
        </div>
        <div className="flex flex-col items-center text-center">
          <span className="text-lg">{config.precision.icon}</span>
          <span className={`text-xs font-medium ${config.precision.color}`}>{config.precision.text}</span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wide">Precision</span>
        </div>
      </div>

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
