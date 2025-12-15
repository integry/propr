import React, { useState } from 'react';
import { AgentConfig } from '../../api/gitfixApi';
import Alert from './Alert';
import AgentConfigModal from './AgentConfigModal';
import { GitHubIcon } from './GitHubIcon';
import { AgentType, ModelInfo, CLAUDE_MODELS, CODEX_MODELS, GEMINI_MODELS } from './agentModels';

interface AgentsListSectionProps {
  agents: AgentConfig[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  onSaveAgents: (agents: AgentConfig[]) => void;
}

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
              <span className="font-medium">Path:</span>{' '}
              <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">{agent.configPath}</code>
            </div>
            <div className="mt-2">
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

                          {/* Context Window Badge */}
                          {modelInfo?.contextWindow && (
                            <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 text-[10px] rounded font-medium" title="Context Window Size">
                              {modelInfo.contextWindow}
                            </span>
                          )}

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
