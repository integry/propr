import React from 'react';
import { Loader2, DollarSign, Zap, Info, BookOpen } from 'lucide-react';
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
}

// Calculate context window usage percentage (assuming 200k context window)
const MAX_CONTEXT_TOKENS = 200000;

const getContextUsagePercentage = (tokens: number): number => {
  return Math.min(100, (tokens / MAX_CONTEXT_TOKENS) * 100);
};

const getUsageColor = (percentage: number): string => {
  if (percentage > 80) return 'bg-red-500';
  if (percentage > 60) return 'bg-yellow-500';
  return 'bg-green-500';
};

export const CostPreview: React.FC<CostPreviewProps> = ({ preview, contextRepositories }) => {
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
  const usagePercentage = getContextUsagePercentage(stats.totalTokens);
  const usageColor = getUsageColor(usagePercentage);

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
          <span>{usagePercentage.toFixed(1)}% of {(MAX_CONTEXT_TOKENS / 1000).toFixed(0)}k</span>
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

      {/* Warnings - styled as neutral info tips */}
      {warnings.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-gray-100">
          {warnings.map((warning, idx) => (
            <div key={idx} className="flex items-start gap-2 text-sm text-gray-600">
              <Info className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
