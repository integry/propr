import React from 'react';
import { Loader2, DollarSign, Zap, Info, BookOpen, RefreshCw, Clock } from 'lucide-react';
import { PreviewResult, ContextRepository } from '../../api/gitfixApi';

interface PreviewState {
  isLoading: boolean;
  data: PreviewResult | null;
  error: string | null;
  lastSynced: Date | null;
}

interface CostPreviewProps {
  preview: PreviewState;
  contextRepositories?: ContextRepository[];
  // Optional refresh indicator props
  isContextStale?: boolean;
  timeUntilRefresh?: number | null;
  onManualRefresh?: () => void;
}

const getUsageColor = (percentage: number, actualPercentage: number): string => {
  // Only use red when context actually exceeds the limit
  if (actualPercentage > 100) return 'bg-red-500';
  // Use purple/indigo for normal usage (including high usage for "Deep Dive" mode)
  if (percentage > 80) return 'bg-indigo-600';
  if (percentage > 60) return 'bg-indigo-500';
  return 'bg-indigo-400';
};

export const CostPreview: React.FC<CostPreviewProps> = ({
  preview,
  contextRepositories,
  isContextStale,
  timeUntilRefresh,
  onManualRefresh
}) => {
  if (preview.isLoading) {
    return (
      <div className="p-5 rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <div>
            <span className="font-medium text-gray-700">Analyzing source code and gathering context...</span>
            <p className="text-sm text-gray-500 mt-0.5">This may take a couple of minutes.</p>
          </div>
        </div>
      </div>
    );
  }

  if (preview.error) {
    return (
      <div className="p-5 rounded-xl border border-red-200 bg-red-50">
        <span className="text-red-600">{preview.error}</span>
      </div>
    );
  }

  if (!preview.data) {
    return (
      <div className="p-5 rounded-xl border border-gray-200 bg-gray-50">
        <span className="text-gray-500">Enter a prompt to see cost estimate</span>
      </div>
    );
  }

  const { stats, smartSelection, warnings } = preview.data;
  
  // Use dynamic maxTokens from stats, fallback to 200k if not available (legacy support)
  const maxTokens = stats.maxTokens || 200000;
  
  const usagePercentage = Math.min(100, (stats.totalTokens / maxTokens) * 100);
  const actualPercentage = (stats.totalTokens / maxTokens) * 100;
  const usageColor = getUsageColor(usagePercentage, actualPercentage);

  return (
    <div className="p-5 rounded-xl border border-gray-200 bg-white shadow-sm space-y-4">
      {/* Main stats row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-gray-400" />
            <span className="text-2xl font-bold text-gray-900">
              ${stats.costEstimate.toFixed(3)}
            </span>
          </div>
          <div className="text-sm text-gray-500">
            <span className="font-medium">{stats.totalTokens.toLocaleString()}</span> tokens
          </div>
        </div>

        {smartSelection.length > 0 && (
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-indigo-500" />
            <span className="text-sm font-medium text-indigo-700 bg-indigo-50 px-3 py-1 rounded-full">
              {smartSelection.filter(f => f.source === 'auto').length} files auto-selected
            </span>
          </div>
        )}
      </div>

      {/* Context window usage bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Context window usage</span>
          <span>{usagePercentage.toFixed(1)}% of {(maxTokens / 1000).toFixed(0)}k</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${usageColor}`}
            style={{ width: `${usagePercentage}%` }}
          />
        </div>
      </div>

      {/* Context repositories indicator */}
      {contextRepositories && contextRepositories.length > 0 && (
        <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
          <BookOpen className="w-4 h-4 text-blue-500" />
          <span className="text-sm text-gray-600">
            Including context from {contextRepositories.length} additional
            {contextRepositories.length === 1 ? ' repository' : ' repositories'}
          </span>
        </div>
      )}

      {/* Warnings and Refresh Indicator - styled as neutral info tips */}
      {(warnings.length > 0 || ((isContextStale || timeUntilRefresh !== null) && onManualRefresh)) && (
        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          {/* Warnings */}
          <div className="space-y-1 flex-1">
            {warnings.map((warning, idx) => (
              <div key={idx} className="flex items-start gap-2 text-sm text-gray-600">
                <Info className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                <span>{warning}</span>
              </div>
            ))}
          </div>

          {/* Compact Refresh Indicator */}
          {(isContextStale || timeUntilRefresh !== null) && onManualRefresh && (
            <div className="flex items-center gap-2 ml-4 flex-shrink-0 relative group/refresh">
              {timeUntilRefresh !== null && (
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {timeUntilRefresh}s
                </span>
              )}
              <button
                onClick={onManualRefresh}
                disabled={preview.isLoading}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`w-4 h-4 ${preview.isLoading ? 'animate-spin' : ''}`} />
              </button>
              {/* Tooltip explaining the refresh logic */}
              <div className="absolute bottom-full right-0 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded shadow-lg opacity-0 group-hover/refresh:opacity-100 transition-opacity pointer-events-none w-64 z-50">
                <div className="font-medium mb-1">Context Refresh</div>
                <div className="text-gray-300 leading-relaxed">
                  {timeUntilRefresh !== null
                    ? 'Changes detected. Waiting before refresh to avoid rapid regeneration while you type. Click to refresh immediately.'
                    : 'Context is outdated. Click to regenerate based on your current prompt and settings.'}
                </div>
                <div className="absolute bottom-0 right-4 transform translate-y-1/2 rotate-45 w-2 h-2 bg-gray-900"></div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
