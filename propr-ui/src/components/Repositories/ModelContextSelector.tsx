import React from 'react';
import { Cpu, Layers } from 'lucide-react';
import { AGENT_MODELS, ModelInfo, AgentType } from '../../config/modelDefinitions';

// Context level configuration
type ContextLevelType = 'focused' | 'expanded' | 'fullscan';

interface ContextLevelOption {
  type: ContextLevelType;
  label: string;
  value: number;
  description: string;
}

const CONTEXT_LEVELS: ContextLevelOption[] = [
  { type: 'focused', label: 'Focused', value: 20, description: 'Fast, lower cost' },
  { type: 'expanded', label: 'Expanded', value: 50, description: 'Balanced' },
  { type: 'fullscan', label: 'Full Scan', value: 90, description: 'Comprehensive' },
];

// Agent display names for optgroup labels
const AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude',
  codex: 'Codex (OpenAI)',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

// Agent order for display
const AGENT_ORDER: AgentType[] = ['claude', 'gemini', 'codex', 'opencode'];

/**
 * Converts a model ID to agent:model format for proper routing.
 * e.g., 'gemini-2.5-flash' -> 'gemini:gemini-2.5-flash'
 */
function getAgentModelFormat(agentType: AgentType, modelId: string): string {
  return `${agentType}:${modelId}`;
}

/**
 * Parses an agent:model format string back to its components.
 * e.g., 'gemini:gemini-2.5-flash' -> { agent: 'gemini', model: 'gemini-2.5-flash' }
 */
function parseAgentModel(value: string): { agent: AgentType | null; model: string } {
  if (value.includes(':')) {
    const [agent, ...modelParts] = value.split(':');
    return { agent: agent as AgentType, model: modelParts.join(':') };
  }
  // Legacy format without agent prefix - assume claude
  return { agent: 'claude', model: value };
}

/**
 * Find the agent type for a given model ID
 */
function findAgentForModel(modelId: string): AgentType | null {
  for (const [agentType, models] of Object.entries(AGENT_MODELS)) {
    if (models.some((m: ModelInfo) => m.id === modelId)) {
      return agentType as AgentType;
    }
  }
  return null;
}

export interface ModelContextSelectorProps {
  /** Selected model ID (supports both plain model ID and agent:model format) */
  selectedModel: string;
  /** Callback when model changes - returns agent:model format */
  onModelChange: (modelId: string) => void;
  /** Selected context level (0-100) */
  contextLevel: number;
  /** Callback when context level changes */
  onContextLevelChange: (level: number) => void;
  /** Whether the selectors are disabled */
  disabled?: boolean;
  /** Optional className for styling */
  className?: string;
}

/**
 * Compact selector component for model and context level.
 * Used in Chat and Improvements panels.
 *
 * Models are grouped by agent (Claude, Gemini, Codex) and the selected value
 * uses the agent:model format for proper routing to the correct LLM backend.
 */
const ModelContextSelector: React.FC<ModelContextSelectorProps> = ({
  selectedModel,
  onModelChange,
  contextLevel,
  onContextLevelChange,
  disabled = false,
  className = '',
}) => {
  // Get current context level type
  const getContextLevelType = (value: number): ContextLevelType => {
    if (value <= 35) return 'focused';
    if (value <= 70) return 'expanded';
    return 'fullscan';
  };

  const currentLevelType = getContextLevelType(contextLevel);

  // Parse selected model to get the model info
  const { model: selectedModelId } = parseAgentModel(selectedModel);

  // Find model info from all agents
  let selectedModelInfo: ModelInfo | undefined;
  for (const models of Object.values(AGENT_MODELS)) {
    const found = models.find((m: ModelInfo) => m.id === selectedModelId);
    if (found) {
      selectedModelInfo = found;
      break;
    }
  }

  // Handle model selection - ensure we use agent:model format
  const handleModelChange = (value: string) => {
    // Value is already in agent:model format from the option
    onModelChange(value);
  };

  // Normalize the selected model to agent:model format for comparison
  const normalizedSelectedModel = selectedModel.includes(':')
    ? selectedModel
    : (() => {
        const agent = findAgentForModel(selectedModel);
        return agent ? getAgentModelFormat(agent, selectedModel) : selectedModel;
      })();

  return (
    <div className={`flex items-center gap-3 px-4 py-2 bg-white border-b border-slate-200 ${className}`}>
      {/* Model Selector */}
      <div className="flex items-center gap-1.5">
        <Cpu className="w-3.5 h-3.5 text-gray-400" />
        <select
          value={normalizedSelectedModel}
          onChange={(e) => handleModelChange(e.target.value)}
          disabled={disabled}
          className={`text-xs bg-transparent border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-teal-500 focus:border-teal-500 ${
            disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-gray-300'
          }`}
        >
          {AGENT_ORDER.map((agentType) => (
            <optgroup key={agentType} label={AGENT_LABELS[agentType]}>
              {AGENT_MODELS[agentType].map((model: ModelInfo) => (
                <option key={model.id} value={getAgentModelFormat(agentType, model.id)}>
                  {model.shortName}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {selectedModelInfo && (
          <span className="text-[10px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded">
            {selectedModelInfo.contextWindow}
          </span>
        )}
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-gray-200" />

      {/* Context Level Selector */}
      <div className="flex items-center gap-1.5">
        <Layers className="w-3.5 h-3.5 text-gray-400" />
        <div className="flex items-center gap-0.5">
          {CONTEXT_LEVELS.map((level) => (
            <button
              key={level.type}
              onClick={() => onContextLevelChange(level.value)}
              disabled={disabled}
              title={level.description}
              className={`text-[10px] px-2 py-1 rounded transition-all ${
                disabled
                  ? 'opacity-50 cursor-not-allowed'
                  : currentLevelType === level.type
                  ? level.type === 'focused'
                    ? 'bg-sky-100 text-sky-700 font-medium'
                    : level.type === 'expanded'
                    ? 'bg-blue-100 text-blue-700 font-medium'
                    : 'bg-indigo-100 text-indigo-700 font-medium'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {level.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ModelContextSelector;
