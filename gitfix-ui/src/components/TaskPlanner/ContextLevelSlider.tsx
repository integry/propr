// CI retrigger
import React, { useMemo, useCallback } from 'react';
import { Layers, Minimize2, Zap, Clock, Cpu, ChevronDown } from 'lucide-react';
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

const MIN_LEVEL = 10;
const MAX_LEVEL = 100;
const STEP = 10;

// Semantic labels for context levels with speed indication
const getSemanticLabel = (value: number): { label: string; description: string; speed: string } => {
  if (value <= 30) {
    return { label: 'Standard', description: 'Essential files only', speed: 'Faster' };
  }
  if (value <= 60) {
    return { label: 'Comprehensive', description: 'Related modules included', speed: 'Moderate' };
  }
  return { label: 'Deep Dive', description: 'Full context analysis', speed: 'Slower' };
};

const getLabelColor = (value: number): string => {
  if (value <= 30) return 'text-green-600 bg-green-50 border-green-200';
  if (value <= 60) return 'text-blue-600 bg-blue-50 border-blue-200';
  return 'text-purple-600 bg-purple-50 border-purple-200';
};

const getSpeedColor = (value: number): string => {
  if (value <= 30) return 'text-green-600';
  if (value <= 60) return 'text-yellow-600';
  return 'text-orange-600';
};

export const ContextLevelSlider: React.FC<ContextLevelSliderProps> = ({ value, onChange, compress = false, onCompressChange, modelName, modelMaxContextTokens, agents = [], generationModel, onGenerationModelChange }) => {
  const semantic = getSemanticLabel(value);
  const labelColor = getLabelColor(value);
  const speedColor = getSpeedColor(value);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-gray-500" />
          <label className="text-sm font-medium text-gray-700">
            Context Level
          </label>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1 text-xs ${speedColor}`}>
            {value <= 30 ? (
              <Zap className="w-3.5 h-3.5" />
            ) : (
              <Clock className="w-3.5 h-3.5" />
            )}
            <span>{semantic.speed}</span>
          </div>
          <div className={`px-3 py-1 text-sm font-medium rounded-full border ${labelColor}`}>
            {semantic.label}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <input
          type="range"
          min={MIN_LEVEL}
          max={MAX_LEVEL}
          step={STEP}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
        />
        <div className="flex justify-between text-xs text-gray-400">
          <span>Standard</span>
          <span>Comprehensive</span>
          <span>Deep Dive</span>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        {semantic.description} ({value}% context window)
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
