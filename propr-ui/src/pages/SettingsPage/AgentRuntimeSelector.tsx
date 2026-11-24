import React from 'react';
import type { AgentConfig } from '../../api/proprApi';
import { SPRITES_RUNTIME_AGENT_TYPES } from './agentCredentialSetupUtils';

const RUNTIME_OPTIONS: ReadonlyArray<{ value: string; label: string; description: string }> = [
  { value: '', label: 'Instance default', description: 'Uses the worker setting (PROPR_AGENT_RUNTIME), Docker unless changed.' },
  { value: 'docker', label: 'Docker', description: 'Runs in the propr/agent container on the worker host.' },
  {
    value: 'sprites',
    label: 'Fly Sprites',
    description: 'Runs on a Fly Sprite with the clone workspace transport. Needs PROPR_SPRITES_TOKEN on the worker.',
  },
];

interface AgentRuntimeSelectorProps {
  agentType: AgentConfig['type'];
  value?: string;
  onChange: (runtime: string | undefined) => void;
}

const AgentRuntimeSelector: React.FC<AgentRuntimeSelectorProps> = ({ agentType, value, onChange }) => {
  const selected = value ?? '';
  const spritesSupported = SPRITES_RUNTIME_AGENT_TYPES.includes(agentType);
  const description = RUNTIME_OPTIONS.find(option => option.value === selected)?.description;
  return (
    <div>
      <span className="block text-gray-700 mb-1.5 font-medium text-sm" id="agent-runtime-label">Runtime</span>
      <div className="flex flex-wrap gap-1 bg-gray-100 rounded-full p-1 w-fit" role="radiogroup" aria-labelledby="agent-runtime-label">
        {RUNTIME_OPTIONS.map(option => {
          const disabled = option.value === 'sprites' && !spritesSupported && selected !== 'sprites';
          return (
            <button
              key={option.value || 'default'}
              type="button"
              role="radio"
              aria-checked={selected === option.value}
              disabled={disabled}
              onClick={() => onChange(option.value || undefined)}
              title={disabled ? 'Fly Sprites runs Claude Code, Codex and Antigravity agents' : undefined}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all disabled:cursor-not-allowed disabled:text-gray-400 ${
                selected === option.value
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {description && <p className="mt-1 text-xs text-gray-500">{description}</p>}
      {selected === 'sprites' && !spritesSupported && (
        <p className="mt-1 text-xs text-red-600">Fly Sprites runs Claude Code, Codex and Antigravity agents only.</p>
      )}
    </div>
  );
};

export default AgentRuntimeSelector;
