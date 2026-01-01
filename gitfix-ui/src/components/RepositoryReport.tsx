import React, { useState, useEffect } from 'react';
import { getStatsOverview, StatsOverviewResponse } from '../api/taskStatsApi';

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
      <div className="bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-xl font-semibold text-white mb-4">Performance Overview</h3>
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-gray-400">Loading performance stats...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-xl font-semibold text-white mb-4">Performance Overview</h3>
        <div className="text-red-400 text-center py-4">{error}</div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-xl font-semibold text-white mb-4">Performance Overview</h3>
        <div className="text-gray-400 text-center py-4">No data available yet.</div>
      </div>
    );
  }

  // Calculate total model usage for percentage bars
  const modelEntries = Object.entries(metrics.usage.models);
  const totalModelCount = modelEntries.reduce((sum, [, count]) => sum + count, 0);

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
    <div className="bg-gray-800/50 rounded-lg p-6 space-y-6">
      <h3 className="text-xl font-semibold text-white">Performance Overview</h3>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Tasks Completed */}
        <div className="bg-gray-700/50 p-4 rounded-lg border border-gray-600/50">
          <p className="text-sm text-gray-400">Tasks Completed</p>
          <p className="text-3xl font-bold text-blue-400">
            {metrics.tasks.completed}
          </p>
          <p className="text-xs text-gray-500">
            {metrics.tasks.planned} Planned
          </p>
        </div>

        {/* Cost & Tokens */}
        <div className="bg-gray-700/50 p-4 rounded-lg border border-gray-600/50">
          <p className="text-sm text-gray-400">Total Cost</p>
          <p className="text-3xl font-bold text-green-400">
            ${metrics.usage.total_cost_usd.toFixed(2)}
          </p>
          <p className="text-xs text-gray-500">
            {formatTokens(metrics.usage.total_tokens)} Tokens
          </p>
        </div>

        {/* PR Effectiveness */}
        <div className="bg-gray-700/50 p-4 rounded-lg border border-gray-600/50">
          <p className="text-sm text-gray-400">PR Iterations (Avg)</p>
          <p className="text-3xl font-bold text-orange-400">
            {metrics.tasks.pr_iterations_avg}
          </p>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>{metrics.tasks.merged_prs} Merged PRs</span>
            <span>{metrics.tasks.total_followups} Follow-ups</span>
          </div>
        </div>

        {/* Indexed Repos */}
        <div className="bg-gray-700/50 p-4 rounded-lg border border-gray-600/50">
          <p className="text-sm text-gray-400">Indexed Repos</p>
          <p className="text-3xl font-bold text-purple-400">
            {metrics.system.repos_indexed}
          </p>
          <p className="text-xs text-gray-500">
            Repositories
          </p>
        </div>
      </div>

      {/* Model Usage Distribution */}
      {modelEntries.length > 0 && (
        <div className="bg-gray-700/50 p-4 rounded-lg border border-gray-600/50">
          <h4 className="font-semibold text-white mb-4">AI Model Distribution</h4>
          <div className="space-y-3">
            {modelEntries.map(([modelId, count]) => {
              const percentage = totalModelCount > 0 ? (count / totalModelCount) * 100 : 0;
              return (
                <div key={modelId} className="flex items-center">
                  <span
                    className="w-48 text-sm text-gray-300 truncate"
                    title={modelId}
                  >
                    {modelId}
                  </span>
                  <div className="flex-1 h-2 bg-gray-600 rounded-full overflow-hidden mx-4">
                    <div
                      className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium text-gray-300 w-16 text-right">
                    {count}
                  </span>
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
