import React, { useState, useEffect } from 'react';
import { getStatsOverview, StatsOverviewResponse } from '../api/taskStatsApi';
import { getModelDisplayName } from '../utils/modelDisplay';
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
    <div className={`w-6 h-6 rounded flex items-center justify-center ${iconColors[family]}`}>
      <ProviderLogo provider={modelId} className="w-4 h-4" />
    </div>
  );
};

interface TopModelsProps {
  limit?: number;
  metricsOverride?: StatsOverviewResponse;
}

const TopModels: React.FC<TopModelsProps> = ({ limit, metricsOverride }) => {
  const [metrics, setMetrics] = useState<StatsOverviewResponse | null>(metricsOverride ?? null);
  const [loading, setLoading] = useState(!metricsOverride);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (metricsOverride) {
      setMetrics(metricsOverride);
      setLoading(false);
      setError(null);
      return;
    }

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
  }, [metricsOverride]);

  if (loading) {
    return (
      <div>
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Models</h3>
        <div className="overflow-hidden animate-pulse">
          <table className="w-full table-fixed">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[55%]">Model</th>
                <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[20%]">Tasks</th>
                <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[25%]">Usage</th>
              </tr>
            </thead>
            <tbody>
              {[...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded bg-gray-200 flex-shrink-0" />
                      <div className="h-4 flex-1 bg-gray-200 rounded" />
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <div className="h-4 w-8 bg-gray-200 rounded ml-auto" />
                  </td>
                  <td className="py-2 px-2">
                    <div className="h-3 w-8 bg-gray-200 rounded ml-auto" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Models</h3>
        <div className="text-red-500 text-center py-4">{error}</div>
      </div>
    );
  }

  if (!metrics || Object.keys(metrics.usage.models).length === 0) {
    return (
      <div>
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Models</h3>
        <div className="text-slate-500 text-center py-4">No model usage yet — data appears after your first task runs.</div>
      </div>
    );
  }

  // Sort models by usage (highest first) and apply limit
  const modelEntries = Object.entries(metrics.usage.models);
  const sortedModelEntries = [...modelEntries].sort((a, b) => b[1] - a[1]);
  const displayModels = limit ? sortedModelEntries.slice(0, limit) : sortedModelEntries;
  const totalModelCount = modelEntries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div>
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Models</h3>
      <div className="overflow-hidden">
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[55%]">Model</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[20%]">Tasks</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[25%]">Usage</th>
            </tr>
          </thead>
          <tbody>
            {displayModels.map(([modelId, count]) => {
              const percentage = totalModelCount > 0 ? (count / totalModelCount) * 100 : 0;
              return (
                <tr key={modelId} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors">
                  <td className="py-2 px-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <ModelIcon modelId={modelId} />
                      <span className="text-slate-800 font-medium text-sm truncate" title={modelId}>
                        {getModelDisplayName(modelId)}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <span className="text-slate-600 text-sm">{count.toLocaleString()}</span>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <span className="text-xs font-medium text-slate-600">
                      {percentage.toFixed(0)}%
                    </span>
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
