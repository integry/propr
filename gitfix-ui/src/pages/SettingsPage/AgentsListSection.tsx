import React, { useState } from 'react';
import { AgentConfig } from '../../api/gitfixApi';
import Alert from './Alert';
import AgentConfigModal from './AgentConfigModal';

// GitHub icon component
const GitHubIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24">
    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
  </svg>
);

interface AgentsListSectionProps {
  agents: AgentConfig[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  onSaveAgents: (agents: AgentConfig[]) => void;
}

type AgentType = 'claude' | 'codex' | 'gemini';

// Model info for display purposes (mirrors AgentConfigModal)
interface ModelInfo {
  id: string;
  name: string;           // Human-readable name
  shortAlias: string;     // Short alias like "opus", "sonnet", "haiku"
  githubLabel: string;    // Format: llm-<agent-alias>-<model-alias>
}

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', shortAlias: 'sonnet', githubLabel: 'llm-claude-sonnet' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', shortAlias: 'haiku', githubLabel: 'llm-claude-haiku' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', shortAlias: 'opus', githubLabel: 'llm-claude-opus' },
];

const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5', name: 'GPT-5', shortAlias: 'gpt5', githubLabel: 'llm-codex-gpt5' },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', shortAlias: 'gpt5-mini', githubLabel: 'llm-codex-gpt5-mini' },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', shortAlias: 'codex', githubLabel: 'llm-codex-codex' },
  { id: 'o3', name: 'OpenAI o3', shortAlias: 'o3', githubLabel: 'llm-codex-o3' },
  { id: 'o4-mini', name: 'OpenAI o4-mini', shortAlias: 'o4-mini', githubLabel: 'llm-codex-o4-mini' },
];

const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', shortAlias: 'pro-preview', githubLabel: 'llm-gemini-pro-preview' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', shortAlias: 'pro', githubLabel: 'llm-gemini-pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', shortAlias: 'flash', githubLabel: 'llm-gemini-flash' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', shortAlias: 'flash-lite', githubLabel: 'llm-gemini-flash-lite' },
];

const MODEL_INFO_MAP: Record<string, ModelInfo> = {};
[...CLAUDE_MODELS, ...CODEX_MODELS, ...GEMINI_MODELS].forEach(m => {
  MODEL_INFO_MAP[m.id] = m;
});

const typeBadgeColors: Record<AgentType, string> = {
  claude: 'bg-orange-100 text-orange-800 border-orange-300',
  codex: 'bg-green-100 text-green-800 border-green-300',
  gemini: 'bg-blue-100 text-blue-800 border-blue-300'
};

const AgentCard: React.FC<{
  agent: AgentConfig;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}> = ({ agent, onEdit, onDelete, onToggle }) => {
  const agentDefaultLabel = `llm-${agent.alias}`;

  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-bold text-lg text-gray-900">{agent.alias}</span>
            <span className={`px-2 py-0.5 text-xs font-medium rounded border capitalize ${typeBadgeColors[agent.type]}`}>
              {agent.type}
            </span>
            {!agent.enabled && (
              <span className="px-2 py-0.5 text-xs font-medium rounded bg-gray-100 text-gray-600 border border-gray-300">
                Disabled
              </span>
            )}
          </div>
          <div className="text-sm text-gray-600 space-y-1">
            <div>
              <span className="font-medium">Image:</span>{' '}
              <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">{agent.dockerImage}</code>
            </div>
            <div>
              <span className="font-medium">Path:</span>{' '}
              <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">{agent.configPath}</code>
            </div>
            <div className="mt-3">
              <span className="font-medium text-gray-700">Supported Models ({agent.supportedModels.length}):</span>
              <div className="flex flex-col gap-2 mt-2">
                {agent.supportedModels.map(modelId => {
                  const modelInfo = MODEL_INFO_MAP[modelId];
                  const isDefault = agent.defaultModel === modelId;

                  return (
                    <div
                      key={modelId}
                      className={`flex items-center justify-between px-3 py-2 bg-gray-50 rounded border ${isDefault ? 'border-teal-300 bg-teal-50' : 'border-gray-200'}`}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">
                            {modelInfo?.name || modelId}
                          </span>
                          {isDefault && (
                            <span className="px-1.5 py-0.5 bg-teal-600 text-white text-xs rounded font-medium">
                              Default
                            </span>
                          )}
                        </div>
                        <code className="text-xs text-gray-500">{modelId}</code>
                        {modelInfo && (
                          <span className="text-xs text-blue-600 mt-0.5">
                            alias: {modelInfo.shortAlias}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 items-end ml-4">
                        {modelInfo && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded font-mono whitespace-nowrap">
                            <GitHubIcon className="w-3 h-3" />
                            {modelInfo.githubLabel}
                          </span>
                        )}
                        {isDefault && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 bg-teal-100 text-teal-700 text-xs rounded font-mono whitespace-nowrap">
                            <GitHubIcon className="w-3 h-3" />
                            {agentDefaultLabel}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

      <div className="flex flex-col gap-2 ml-4 items-end">
        {/* Toggle Switch */}
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={agent.enabled}
            onChange={onToggle}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
        </label>

        {/* Action Buttons */}
        <div className="flex gap-2 mt-2">
          <button
            onClick={onEdit}
            className="px-3 py-1 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md border border-gray-300 transition-colors"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </div>
  );
};

const AgentsListSection: React.FC<AgentsListSectionProps> = ({
  agents,
  loading,
  saving,
  error,
  success,
  onSaveAgents
}) => {
  const [showModal, setShowModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null);

  const handleAddAgent = () => {
    setEditingAgent(null);
    setShowModal(true);
  };

  const handleEditAgent = (agent: AgentConfig) => {
    setEditingAgent(agent);
    setShowModal(true);
  };

  const handleDeleteAgent = (agent: AgentConfig) => {
    if (confirm(`Are you sure you want to delete the agent "${agent.alias}"?`)) {
      const updatedAgents = agents.filter(a => a.id !== agent.id);
      onSaveAgents(updatedAgents);
    }
  };

  const handleToggleAgent = (agent: AgentConfig) => {
    const updatedAgents = agents.map(a =>
      a.id === agent.id ? { ...a, enabled: !a.enabled } : a
    );
    onSaveAgents(updatedAgents);
  };

  const handleSaveAgent = (agent: AgentConfig) => {
    let updatedAgents: AgentConfig[];
    const existingIndex = agents.findIndex(a => a.id === agent.id);

    if (existingIndex >= 0) {
      // Update existing agent
      updatedAgents = [...agents];
      updatedAgents[existingIndex] = agent;
    } else {
      // Add new agent
      updatedAgents = [...agents, agent];
    }

    onSaveAgents(updatedAgents);
    setShowModal(false);
    setEditingAgent(null);
  };

  const existingAliases = agents
    .filter(a => !editingAgent || a.id !== editingAgent.id)
    .map(a => a.alias);

  return (
    <div className="mb-8">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-gray-900 text-xl font-semibold">AI Agents</h3>
          <p className="text-gray-600 mt-1">
            Configure AI agents to process issues. Each agent represents a different LLM provider.
          </p>
        </div>
        <button
          onClick={handleAddAgent}
          disabled={loading || saving}
          className={`px-4 py-2 font-medium rounded-md transition-colors ${
            loading || saving
              ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
              : 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
          }`}
        >
          Add Agent
        </button>
      </div>

      {error && <Alert message={error} type="error" />}
      {success && <Alert message={success} type="success" />}

      {loading ? (
        <p className="text-gray-600">Loading agents...</p>
      ) : (
        <div className="space-y-3">
          {agents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onEdit={() => handleEditAgent(agent)}
              onDelete={() => handleDeleteAgent(agent)}
              onToggle={() => handleToggleAgent(agent)}
            />
          ))}
          {agents.length === 0 && (
            <div className="text-center py-12 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-gray-600">No agents configured.</p>
              <p className="text-gray-500 text-sm mt-1">
                Click "Add Agent" to configure your first AI agent.
              </p>
            </div>
          )}
        </div>
      )}

      {saving && (
        <p className="text-gray-600 mt-4">Saving agents...</p>
      )}

      {showModal && (
        <AgentConfigModal
          agent={editingAgent}
          existingAliases={existingAliases}
          onClose={() => {
            setShowModal(false);
            setEditingAgent(null);
          }}
          onSave={handleSaveAgent}
        />
      )}
    </div>
  );
};

export default AgentsListSection;
