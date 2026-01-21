import React, { useState, useEffect } from 'react';
import { getStatsOverview, StatsOverviewResponse } from '../api/taskStatsApi';
import { ProviderLogo } from './ui/ProviderLogo';

// Model icon component using ProviderLogo for visual grouping
const ModelIcon: React.FC<{ modelId: string }> = ({ modelId }) => {
  const getModelFamily = (id: string): string => {
    const lower = id.toLowerCase();
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
    gemini: 'bg-blue-100 text-blue-600',
    llama: 'bg-orange-100 text-orange-600',
    other: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className={`w-6 h-6 rounded flex items-center justify-center ${iconColors[family]}`}>
      <ProviderLogo provider={modelId} className="w-4 h-4" />
    </div>
  );
};

interface TopModelsProps {
  limit?: number;
}

const TopModels: React.FC<TopModelsProps> = ({ limit }) => {
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
        setError(err instanceof Error ? err.message : 'Failed to load model stats');
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
      <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
        <h3 className="text-lg font-bold text-slate-800 mb-4">Top Models</h3>
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-slate-500">Loading model stats...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
        <h3 className="text-lg font-bold text-slate-800 mb-4">Top Models</h3>
        <div className="text-red-500 text-center py-4">{error}</div>
      </div>
    );
  }

  if (!metrics || Object.keys(metrics.usage.models).length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
        <h3 className="text-lg font-bold text-slate-800 mb-4">Top Models</h3>
        <div className="text-slate-500 text-center py-4">No model data available yet.</div>
      </div>
    );
  }

  // Sort models by usage (highest first) and apply limit
  const modelEntries = Object.entries(metrics.usage.models);
  const sortedModelEntries = [...modelEntries].sort((a, b) => b[1] - a[1]);
  const displayModels = limit ? sortedModelEntries.slice(0, limit) : sortedModelEntries;
  const totalModelCount = modelEntries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
      <h3 className="text-lg font-bold text-slate-800 mb-4">Top Models</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Model</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Tasks</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Usage</th>
            </tr>
          </thead>
          <tbody>
            {displayModels.map(([modelId, count]) => {
              const percentage = totalModelCount > 0 ? (count / totalModelCount) * 100 : 0;
              return (
                <tr key={modelId} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-2">
                      <ModelIcon modelId={modelId} />
                      <span className="text-slate-800 font-medium text-sm truncate block max-w-[200px]" title={modelId}>
                        {modelId}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <span className="text-slate-600 text-sm">{count.toLocaleString()}</span>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-12 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
                          style={{ width: `${Math.max(percentage, 2)}%` }}
                        />
                      </div>
                      <span className="text-xs font-medium text-slate-600 w-10 text-right">
                        {percentage.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TopModels;
