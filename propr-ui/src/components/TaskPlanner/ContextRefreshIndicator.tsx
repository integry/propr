import React from 'react';

interface ContextRefreshIndicatorProps {
  isContextStale: boolean;
  timeUntilRefresh: number | null;
  isLoading: boolean;
  onManualRefresh: () => void;
}

export const ContextRefreshIndicator: React.FC<ContextRefreshIndicatorProps> = ({
  isContextStale,
  timeUntilRefresh,
  isLoading,
  onManualRefresh
}) => {
  if (!isContextStale && timeUntilRefresh === null) {
    return null;
  }

  return (
    <div className="mt-2 flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-lg">
      <div className="flex items-center gap-2 text-amber-700">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="text-sm">
          {timeUntilRefresh !== null
            ? `Context will refresh in ${timeUntilRefresh}s`
            : 'Context is stale'}
        </span>
      </div>
      <button
        onClick={onManualRefresh}
        disabled={isLoading}
        className="px-3 py-1 text-sm font-medium text-amber-700 bg-amber-100 hover:bg-amber-200 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
      >
        <svg className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Refresh Now
      </button>
    </div>
  );
};
