import React from 'react';
import {
  AGENT_DISPLAY_ORDER,
  type AgentType,
} from '../../config/modelDefinitions';

interface AgentTypeSelectorProps {
  value: AgentType;
  onChange: (type: AgentType) => void;
}

const AgentTypeSelector: React.FC<AgentTypeSelectorProps> = ({ value, onChange }) => (
  <div>
    <span className="block text-gray-700 mb-1.5 font-medium text-sm">Agent Type</span>
    <div className="flex flex-wrap gap-1 bg-gray-100 rounded-full p-1 w-fit">
      {AGENT_DISPLAY_ORDER.map(type => (
        <button
          key={type}
          type="button"
          onClick={() => onChange(type)}
          className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize transition-all ${
            value === type
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          {type === 'opencode' ? 'OpenCode' : type === 'antigravity' ? 'Antigravity' : type}
        </button>
      ))}
    </div>
  </div>
);

export default AgentTypeSelector;
