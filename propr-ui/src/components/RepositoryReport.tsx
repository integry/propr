import React, { useState, useEffect } from 'react';
import { getStatsOverview, StatsOverviewResponse } from '../api/taskStatsApi';
import { ProviderLogo } from './ui/ProviderLogo';

// Model icon component using ProviderLogo for visual grouping
const ModelIcon: React.FC<{ modelId: string }> = ({ modelId }) => {
  const getModelFamily = (id: string): string => {
    const lower = id.toLowerCase();
    if (lower.includes('antigravity')) return 'antigravity';
    if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
    if (lower.includes('gpt') || lower.includes('openai')) return 'openai';
    if (lower.includes('gemini') || lower.includes('google')) return 'gemini';
    if (lower.includes('llama') || lower.includes('meta')) return 'llama';
    return 'other';
  };

  const family = getModelFamily(modelId);
  const iconColors: Record<string, string> = {
    claude: 'bg-violet-100 text-violet-600',
    openai: 'bg-emerald-100 text-emerald-600',
    antigravity: 'bg-fuchsia-100 text-fuchsia-600',
    gemini: 'bg-blue-100 text-blue-600',
    llama: 'bg-orange-100 text-orange-600',
    other: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className={`w-7 h-7 rounded-md flex items-center justify-center ${iconColors[family]}`}>
      <ProviderLogo provider={modelId} className="w-4 h-4" />
    </div>
  );
};

const RepositoryReport: React.FC = () => {
  const [metrics, setMetrics] = useState<StatsOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getStatsOverview();
        setMetrics(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load performance stats');
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="dashboard-card">
        <h3 className="section-header">Performance Overview</h3>
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-slate-500">Loading performance stats...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-card">
        <h3 className="section-header">Performance Overview</h3>
        <div className="text-red-500 text-center py-4">{error}</div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="dashboard-card">
        <h3 className="section-header">Performance Overview</h3>
        <div className="text-slate-500 text-center py-4">No data available yet.</div>
      </div>
    );
  }

  // Calculate total model usage for percentage bars
  const modelEntries = Object.entries(metrics.usage.models);
  const totalModelCount = modelEntries.reduce((sum, [, count]) => sum + count, 0);

  // Sort models by usage (highest first)
  const sortedModelEntries = [...modelEntries].sort((a, b) => b[1] - a[1]);

  // Format tokens for display (convert to millions if large)
  const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(2)}M`;
    }
    if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return tokens.toString();
  };

  return (
    <div className="dashboard-card space-y-6">
      <h3 className="section-header !mb-0">Performance Overview</h3>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Tasks Completed */}
        <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
          <p className="stat-label">Tasks Completed</p>
          <p className="stat-value text-indigo-600">
            {metrics.tasks.completed}
          </p>
          <p className="text-xs text-slate-400">
            {metrics.tasks.planned} Planned
          </p>
        </div>

        {/* Cost & Tokens */}
        <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
          <p className="stat-label">Total Cost</p>
          <p className="stat-value text-violet-600">
            ${metrics.usage.total_cost_usd.toFixed(2)}
          </p>
          <p className="text-xs text-slate-400">
            {formatTokens(metrics.usage.total_tokens)} Tokens
          </p>
        </div>

        {/* PR Effectiveness */}
        <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
          <p className="stat-label">PR Iterations (Avg)</p>
          <p className="stat-value text-amber-600">
            {metrics.tasks.pr_iterations_avg}
          </p>
          <div className="flex justify-between text-xs text-slate-400 mt-1">
            <span>{metrics.tasks.merged_prs} PRs Created</span>
            <span>{metrics.tasks.total_followups} Follow-ups</span>
          </div>
        </div>

        {/* Indexed Repos */}
        <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
          <p className="stat-label">Indexed Repos</p>
          <p className="stat-value text-indigo-600">
            {metrics.system.repos_indexed}
          </p>
          <p className="text-xs text-slate-400">
            Repositories
          </p>
        </div>
      </div>

      {/* Model Usage Distribution */}
      {sortedModelEntries.length > 0 && (
        <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
          <h4 className="font-semibold text-slate-800 mb-4">AI Model Distribution</h4>
          <div className="space-y-1">
            {sortedModelEntries.map(([modelId, count]) => {
              const percentage = totalModelCount > 0 ? (count / totalModelCount) * 100 : 0;
              return (
                <div
                  key={modelId}
                  className="flex items-center gap-3 py-2.5 px-3 rounded-lg transition-colors duration-150 hover:bg-white hover:shadow-sm cursor-default group"
                >
                  {/* Model Icon */}
                  <ModelIcon modelId={modelId} />

                  {/* Model Name - Left Aligned */}
                  <span
                    className="w-40 sm:w-48 md:w-56 text-sm font-medium text-slate-700 truncate"
                    title={modelId}
                  >
                    {modelId}
                  </span>

                  {/* Thin Progress Bar - Middle */}
                  <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full transition-all duration-300"
                      style={{ width: `${Math.max(percentage, 2)}%` }}
                    />
                  </div>

                  {/* Count and Percentage - Right Aligned */}
                  <div className="flex items-center gap-2 min-w-[100px] justify-end">
                    <span className="text-sm font-semibold text-slate-800">
                      {count.toLocaleString()}
                    </span>
                    <span className="text-xs text-slate-500 w-12 text-right">
                      {percentage.toFixed(1)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default RepositoryReport;
