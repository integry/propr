import React, { useState } from 'react';
import { AgentConfig, getAgentUsageStats, AgentUsageStats } from '../../api/gitfixApi';
import Alert from './Alert';
import AgentConfigModal from './AgentConfigModal';
import { MODEL_INFO_MAP, typeBadgeColors } from '../../config/modelDefinitions';
import { ProviderLogo } from '../../components/ui/ProviderLogo';

// --- Icons ---

const GitHubIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24">
    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
  </svg>
);

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

const TagIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
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

const ChartBarIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
);

const RefreshIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

// --- Components ---

// Usage bar component
const UsageBar: React.FC<{
  label: string;
  percentage: number;
  resetTime?: string;
}> = ({ label, percentage, resetTime }) => (
  <div className="mb-3">
    <div className="flex justify-between items-center mb-1">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <span className="text-sm text-gray-600">{percentage}% used</span>
    </div>
    <div className="w-full bg-gray-200 rounded-full h-2.5">
      <div
        className={`h-2.5 rounded-full transition-all duration-300 ${
          percentage >= 90 ? 'bg-red-500' :
          percentage >= 70 ? 'bg-yellow-500' :
          'bg-blue-500'
        }`}
        style={{ width: `${Math.min(percentage, 100)}%` }}
      />
    </div>
    {resetTime && (
      <div className="text-xs text-gray-500 mt-0.5">Resets {resetTime}</div>
    )}
  </div>
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

const AgentCard: React.FC<{
  agent: AgentConfig;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}> = ({ agent, onEdit, onDelete, onToggle }) => {
  const agentDefaultLabel = `llm-${agent.alias}`;
  const [usageStats, setUsageStats] = useState<AgentUsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);

  const fetchUsageStats = async () => {
    if (agent.type !== 'claude') return;

    setUsageLoading(true);
    setUsageError(null);
    try {
      const response = await getAgentUsageStats(agent.id);
      setUsageStats(response.usage);
    } catch (err) {
      setUsageError((err as Error).message || 'Failed to fetch usage stats');
    } finally {
      setUsageLoading(false);
    }
  };

  const handleToggleUsage = () => {
    if (!showUsage && !usageStats && !usageLoading) {
      fetchUsageStats();
    }
    setShowUsage(!showUsage);
  };

  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm">
      {/* --- Header Section --- */}
      <div className="flex justify-between items-start mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
             {/* Status Dot */}
            <div className={`w-2.5 h-2.5 rounded-full ${agent.enabled ? 'bg-green-500' : 'bg-gray-300'}`} title={agent.enabled ? "Active" : "Disabled"} />

            <ProviderLogo provider={agent.alias} className="w-5 h-5 text-gray-700" />
            <span className="font-bold text-lg text-gray-900">{agent.alias}</span>
            <span className={`px-2 py-0.5 text-xs font-medium rounded border capitalize ${typeBadgeColors[agent.type]}`}>
              {agent.type}
            </span>
          </div>
          <div className="text-sm text-gray-600 ml-5">
            <div>
              <span className="font-medium mr-2">Path:</span>
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs text-gray-600 font-mono border border-gray-200">
                {agent.configPath}
              </code>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 ml-4">
          {/* Action Buttons */}
          <div className="flex items-center gap-1">
            {/* Usage stats button - only for Claude agents */}
            {agent.type === 'claude' && (
              <button
                onClick={handleToggleUsage}
                className={`p-1.5 rounded transition-colors ${
                  showUsage
                    ? 'text-blue-600 bg-blue-50 hover:bg-blue-100'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
                title="View usage statistics"
              >
                <ChartBarIcon className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onEdit}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
              title="Edit agent"
            >
              <PencilIcon className="w-4 h-4" />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
              title="Delete agent"
            >
              <TrashIcon className="w-4 h-4" />
            </button>
          </div>

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
        </div>
      </div>

      {/* --- Capabilities List (Models) --- */}
      <div className="ml-5 mt-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Active models</h4>
        <div className="overflow-x-auto border border-gray-200 rounded-md">
          <table className="min-w-full text-sm text-left bg-white">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase font-medium">
              <tr>
                <th className="px-4 py-2 border-b border-gray-200 w-1/3">Model Name</th>
                <th className="px-4 py-2 border-b border-gray-200 w-24">Context</th>
                <th className="px-4 py-2 border-b border-gray-200">ID / Alias</th>
                <th className="px-4 py-2 border-b border-gray-200 text-right">
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    <GitHubIcon className="w-3.5 h-3.5" />
                    Issue labels
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agent.supportedModels.map(modelId => {
                const modelInfo = MODEL_INFO_MAP[modelId];
                const isDefault = agent.defaultModel === modelId;

                return (
                  <tr key={modelId} className="hover:bg-gray-50 transition-colors">
                    {/* Name Column */}
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm ${isDefault ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
                          {modelInfo?.name || modelId}
                        </span>
                        {isDefault && (
                          <span className="px-1.5 py-0.5 bg-teal-50 text-teal-700 border border-teal-200 text-[9px] rounded uppercase font-semibold tracking-wide">
                            Default
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Context Column */}
                    <td className="px-4 py-3 align-top">
                      {modelInfo?.contextWindow && (
                        <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 border border-gray-200 text-[10px] rounded font-medium">
                          {modelInfo.contextWindow}
                        </span>
                      )}
                    </td>

                    {/* ID / Alias Column */}
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-purple-700 font-mono bg-purple-50 px-1 rounded">
                            {modelId}
                          </code>
                          <CopyButton text={modelId} className="hover:text-purple-600" />
                        </div>
                        {modelInfo?.shortAlias && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">
                              alias: <span className="font-mono">{modelInfo.shortAlias}</span>
                            </span>
                            <CopyButton text={modelInfo.shortAlias} />
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Tags Column */}
                    <td className="px-4 py-3 align-top text-right">
                      <div className="flex flex-col gap-1 items-end">
                        {modelInfo?.githubLabel && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-gray-500 hover:text-gray-900 border border-transparent hover:border-gray-200 rounded text-xs transition-all cursor-default opacity-70 hover:opacity-100">
                            <TagIcon className="w-3 h-3" />
                            {modelInfo.githubLabel}
                          </span>
                        )}
                        {isDefault && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-teal-600 border border-transparent rounded text-xs opacity-70">
                            <TagIcon className="w-3 h-3" />
                            {agentDefaultLabel}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- Usage Statistics Panel (Claude only) --- */}
      {agent.type === 'claude' && showUsage && (
        <div className="ml-5 mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex justify-between items-center mb-3">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Usage Statistics</h4>
            <button
              onClick={fetchUsageStats}
              disabled={usageLoading}
              className="p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors disabled:opacity-50"
              title="Refresh usage stats"
            >
              <RefreshIcon className={`w-4 h-4 ${usageLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {usageLoading && !usageStats && (
            <div className="text-sm text-gray-500 flex items-center gap-2">
              <RefreshIcon className="w-4 h-4 animate-spin" />
              Loading usage statistics...
            </div>
          )}

          {usageError && (
            <div className="text-sm text-red-600 bg-red-50 p-2 rounded border border-red-200">
              {usageError}
            </div>
          )}

          {usageStats && (
            <div className="space-y-1">
              <UsageBar
                label="Current session"
                percentage={usageStats.currentSessionUsed}
                resetTime={usageStats.sessionResetTime}
              />
              <UsageBar
                label="Current week (all models)"
                percentage={usageStats.currentWeekAllModelsUsed}
                resetTime={usageStats.weekAllModelsResetTime}
              />
              {usageStats.currentWeekSonnetUsed !== undefined && (
                <UsageBar
                  label="Current week (Sonnet only)"
                  percentage={usageStats.currentWeekSonnetUsed}
                  resetTime={usageStats.weekSonnetResetTime}
                />
              )}
            </div>
          )}
        </div>
      )}
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
        <div className="space-y-4">
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
