import React, { useState } from 'react';
import { AgentConfig, getAgentUsageStats, AgentUsageStats } from '../../api/gitfixApi';
import { MODEL_INFO_MAP, typeBadgeColors } from '../../config/modelDefinitions';
import { ProviderLogo } from '../../components/ui/ProviderLogo';
import { GitHubIcon, CopyIcon, CheckIcon, TagIcon, PencilIcon, TrashIcon, ChartBarIcon, RefreshIcon } from './icons';

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

export interface AgentCardProps {
  agent: AgentConfig;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({ agent, onEdit, onDelete, onToggle }) => {
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
    if (!showUsage && !usageStats && !usageLoading) fetchUsageStats();
    setShowUsage(!showUsage);
  };

  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm">
      <div className="flex justify-between items-start mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <div className={`w-2.5 h-2.5 rounded-full ${agent.enabled ? 'bg-green-500' : 'bg-gray-300'}`} title={agent.enabled ? "Active" : "Disabled"} />
            <ProviderLogo provider={agent.alias} className="w-5 h-5 text-gray-700" />
            <span className="font-bold text-lg text-gray-900">{agent.alias}</span>
            <span className={`px-2 py-0.5 text-xs font-medium rounded border capitalize ${typeBadgeColors[agent.type]}`}>{agent.type}</span>
          </div>
          <div className="text-sm text-gray-600 ml-5">
            <div>
              <span className="font-medium mr-2">Path:</span>
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs text-gray-600 font-mono border border-gray-200">{agent.configPath}</code>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 ml-4">
          <div className="flex items-center gap-1">
            {agent.type === 'claude' && (
              <button onClick={handleToggleUsage} className={`p-1.5 rounded transition-colors ${showUsage ? 'text-blue-600 bg-blue-50 hover:bg-blue-100' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`} title="View usage statistics">
                <ChartBarIcon className="w-4 h-4" />
              </button>
            )}
            <button onClick={onEdit} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors" title="Edit agent"><PencilIcon className="w-4 h-4" /></button>
            <button onClick={onDelete} className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete agent"><TrashIcon className="w-4 h-4" /></button>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" checked={agent.enabled} onChange={onToggle} className="sr-only peer" />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
          </label>
        </div>
      </div>
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
                  <span className="inline-flex items-center gap-1.5 justify-end"><GitHubIcon className="w-3.5 h-3.5" />Issue labels</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agent.supportedModels.map(modelId => {
                const modelInfo = MODEL_INFO_MAP[modelId];
                const isDefault = agent.defaultModel === modelId;
                return (
                  <tr key={modelId} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm ${isDefault ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>{modelInfo?.name || modelId}</span>
                        {isDefault && <span className="px-1.5 py-0.5 bg-teal-50 text-teal-700 border border-teal-200 text-[9px] rounded uppercase font-semibold tracking-wide">Default</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">{modelInfo?.contextWindow && <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 border border-gray-200 text-[10px] rounded font-medium">{modelInfo.contextWindow}</span>}</td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2"><code className="text-xs text-purple-700 font-mono bg-purple-50 px-1 rounded">{modelId}</code><CopyButton text={modelId} className="hover:text-purple-600" /></div>
                        {modelInfo?.shortAlias && <div className="flex items-center gap-2"><span className="text-xs text-gray-500">alias: <span className="font-mono">{modelInfo.shortAlias}</span></span><CopyButton text={modelInfo.shortAlias} /></div>}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top text-right">
                      <div className="flex flex-col gap-1 items-end">
                        {modelInfo?.githubLabel && <span className="inline-flex items-center gap-1 px-2 py-0.5 text-gray-500 hover:text-gray-900 border border-transparent hover:border-gray-200 rounded text-xs transition-all cursor-default opacity-70 hover:opacity-100"><TagIcon className="w-3 h-3" />{modelInfo.githubLabel}</span>}
                        {isDefault && <span className="inline-flex items-center gap-1 px-2 py-0.5 text-teal-600 border border-transparent rounded text-xs opacity-70"><TagIcon className="w-3 h-3" />{agentDefaultLabel}</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {agent.type === 'claude' && showUsage && (
        <div className="ml-5 mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex justify-between items-center mb-3">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Usage Statistics</h4>
            <button onClick={fetchUsageStats} disabled={usageLoading} className="p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors disabled:opacity-50" title="Refresh usage stats">
              <RefreshIcon className={`w-4 h-4 ${usageLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {usageLoading && !usageStats && <div className="text-sm text-gray-500 flex items-center gap-2"><RefreshIcon className="w-4 h-4 animate-spin" />Loading usage statistics...</div>}
          {usageError && <div className="text-sm text-red-600 bg-red-50 p-2 rounded border border-red-200">{usageError}</div>}
          {usageStats && (
            <div className="space-y-1">
              <UsageBar label="Current session" percentage={usageStats.currentSessionUsed} resetTime={usageStats.sessionResetTime} />
              <UsageBar label="Current week (all models)" percentage={usageStats.currentWeekAllModelsUsed} resetTime={usageStats.weekAllModelsResetTime} />
              {usageStats.currentWeekSonnetUsed !== undefined && <UsageBar label="Current week (Sonnet only)" percentage={usageStats.currentWeekSonnetUsed} resetTime={usageStats.weekSonnetResetTime} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
