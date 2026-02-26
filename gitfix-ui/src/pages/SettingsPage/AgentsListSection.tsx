import React, { useState } from 'react';
import { AgentConfig } from '../../api/gitfixApi';
import Alert from './Alert';
import AgentConfigModal from './AgentConfigModal';
import { MODEL_INFO_MAP, typeBadgeColors } from '../../config/modelDefinitions';
import { ProviderLogo } from '../../components/ui/ProviderLogo';

// --- Icons ---

const CopyIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const PencilIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

const TrashIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const GitHubIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
  </svg>
);

// --- Components ---

interface CopyButtonProps {
  text: string;
  className?: string;
}

const CopyButton: React.FC<CopyButtonProps> = ({ text, className = "" }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`text-gray-400 hover:text-gray-600 transition-colors inline-flex items-center justify-center ${className}`}
      title="Copy to clipboard"
    >
      {copied ? <CheckIcon className="w-3 h-3 text-green-500" /> : <CopyIcon className="w-3 h-3" />}
    </button>
  );
};

interface AgentsListSectionProps {
  agents: AgentConfig[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  onSaveAgents: (agents: AgentConfig[]) => void;
}

// Code Chip component for consistent styling of IDs, aliases, and paths
const CodeChip: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <code className={`px-1.5 py-0.5 bg-gray-100 text-gray-700 text-xs font-mono rounded-md border border-gray-200 ${className}`}>
    {children}
  </code>
);

// High-density model row component
const ModelRow: React.FC<{
  modelId: string;
  modelInfo: typeof MODEL_INFO_MAP[string] | undefined;
  isDefault: boolean;
  customLabel?: string;
}> = ({ modelId, modelInfo, isDefault, customLabel }) => (
  <div className="flex items-start py-1.5 px-3 hover:bg-gray-50 transition-colors text-sm">
    {/* Name + Badge column */}
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <span className={`truncate ${isDefault ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
        {modelInfo?.name || modelId}
      </span>
      {customLabel && (
        <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 text-[10px] rounded font-medium flex-shrink-0">
          {customLabel}
        </span>
      )}
      {isDefault && (
        <span className="px-1.5 py-0.5 bg-teal-50 text-teal-700 border border-teal-200 text-[9px] rounded uppercase font-semibold tracking-wide flex-shrink-0">
          Default
        </span>
      )}
    </div>

    {/* Context Limit column - fixed width for alignment */}
    <div className="w-16 text-right flex-shrink-0 mr-4">
      {modelInfo?.contextWindow && (
        <span className="font-mono text-xs text-gray-600">{modelInfo.contextWindow}</span>
      )}
    </div>

    {/* ID/Alias column - allows wrapping to second line */}
    <div className="flex flex-wrap items-center gap-1.5 flex-shrink-0 w-[240px] justify-end">
      <span className="inline-flex items-center gap-1">
        <CodeChip className="bg-purple-50 text-purple-700 border-purple-200">{modelId}</CodeChip>
        <CopyButton text={modelId} className="hover:text-purple-600" />
      </span>
      {modelInfo?.shortAlias && (
        <span className="inline-flex items-center gap-1">
          <CodeChip>{modelInfo.shortAlias}</CodeChip>
          <CopyButton text={modelInfo.shortAlias} />
        </span>
      )}
    </div>
  </div>
);

const AgentCard: React.FC<{
  agent: AgentConfig;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}> = ({ agent, onEdit, onDelete, onToggle }) => {
  return (
    <div className="border-b border-gray-200 py-3 last:border-b-0">
      {/* --- Agent Header: [Icon] [Bold Name] [Brand Badge] ... [Toggle] [Edit] --- */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ProviderLogo provider={agent.alias} className="w-5 h-5 text-gray-700 flex-shrink-0" />
          <span className="font-bold text-gray-900">{agent.alias}</span>
          <span className={`px-2 py-0.5 text-xs font-medium rounded border capitalize ${typeBadgeColors[agent.type]}`}>
            {agent.type}
          </span>
          <CodeChip>{agent.configPath}</CodeChip>
        </div>

        <div className="flex items-center gap-2">
          {/* Toggle Switch */}
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={agent.enabled}
              onChange={onToggle}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
          </label>

          {/* Edit Button */}
          <button
            onClick={onEdit}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
            title="Edit agent"
          >
            <PencilIcon className="w-4 h-4" />
          </button>

          {/* Delete Button */}
          <button
            onClick={onDelete}
            className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
            title="Delete agent"
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* --- High-Density Model Rows --- */}
      <div className="mt-2 ml-7 bg-gray-50 rounded-md border border-gray-100">
        {/* Header row */}
        <div className="flex items-center py-1 px-3 text-[10px] text-gray-500 uppercase tracking-wide font-medium border-b border-gray-100">
          <div className="flex-1">Model</div>
          <div className="w-16 text-right flex-shrink-0 mr-4">Context</div>
          <div className="flex items-center gap-1 w-[240px] justify-end">
            <GitHubIcon className="w-3 h-3" />
            <span>ID / Alias</span>
          </div>
        </div>

        {/* Model rows */}
        {agent.supportedModels.map(modelId => {
          const modelInfo = MODEL_INFO_MAP[modelId];
          const isDefault = agent.defaultModel === modelId;
          const modelCustomLabel = agent.modelCustomLabels?.[modelId];

          return (
            <ModelRow
              key={modelId}
              modelId={modelId}
              modelInfo={modelInfo}
              isDefault={isDefault}
              customLabel={modelCustomLabel}
            />
          );
        })}
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
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-gray-600">
          Configure AI agents to process issues. Each agent represents a different LLM provider.
        </p>
        <button
          onClick={handleAddAgent}
          disabled={loading || saving}
          className={`px-4 py-2 font-medium rounded-md transition-colors flex-shrink-0 ${
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
        <div>
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
