import React from 'react';
import { Loader2, Info, BookOpen, RefreshCw, Clock, Pause, Play } from 'lucide-react';
import { PreviewResult, ContextRepository, GenerationTrace } from '../../api/proprApi';
import { GenerationProgress } from './GenerationProgress';

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
  isPaused?: boolean;
  onTogglePause?: () => void;
  // Mode indicator
  isNewMode?: boolean;
  // Preview trace for progress display during context loading (shown in right pane)
  previewTrace?: GenerationTrace;
  // Whether preview progress should render in the right pane
  showPreviewProgress?: boolean;
  hideCostsAndTokens?: boolean;
  hideRefreshControls?: boolean;
}

const getUsageColor = (percentage: number, actualPercentage: number): string => {
  // Only use red when context actually exceeds the limit
  if (actualPercentage > 100) return 'bg-red-500';
  // Use purple/indigo for normal usage (including high usage for "Deep Dive" mode)
  if (percentage > 80) return 'bg-indigo-600';
  if (percentage > 60) return 'bg-indigo-500';
  return 'bg-indigo-400';
};

interface LoadingStateProps {
  previewTrace?: GenerationTrace;
}

const LoadingState: React.FC<LoadingStateProps> = ({ previewTrace }) => {
  // If we have trace data with non-completed steps, show the progress component
  // This ensures consistent UI without switching between spinner and progress bar
  // We only check for non-completed steps since completed steps will be hidden
  const hasActiveSteps = previewTrace?.steps?.some(step =>
    ['relevance', 'context'].includes(step.name) && step.status !== 'completed'
  );

  if (hasActiveSteps) {
    return (
      <div className="pt-4 border-t border-gray-200 overflow-hidden">
        <GenerationProgress trace={previewTrace} hideCompletedSteps />
      </div>
    );
  }

  // Default loading state only when trace data is not yet available
  return (
    <div className="pt-3 sm:pt-4 border-t border-gray-200">
      <div className="flex items-center gap-2 sm:gap-3 text-gray-500">
        <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin flex-shrink-0" />
        <div>
          <span className="font-medium text-gray-700 text-sm sm:text-base">
            <span className="hidden sm:inline">Analyzing source code and gathering context...</span>
            <span className="sm:hidden">Analyzing context...</span>
          </span>
          <p className="hidden sm:block text-sm text-gray-500 mt-0.5">This may take a couple of minutes.</p>
        </div>
      </div>
    </div>
  );
};

const DeferredLoadingState: React.FC = () => (
  <div className="pt-3 sm:pt-4 border-t border-gray-200">
    <div className="flex items-center justify-between">
      <span className="hidden sm:inline text-gray-500">
        Cost estimate will be available after context analysis
      </span>
      <span className="sm:hidden text-gray-500 text-xs">
        Cost after context analysis
      </span>
    </div>
  </div>
);

const ErrorState: React.FC<{ error: string }> = ({ error }) => (
  <div className="pt-4 border-t border-gray-200">
    <span className="text-red-600">{error}</span>
  </div>
);

interface EmptyStateProps {
  isContextStale?: boolean;
  timeUntilRefresh?: number | null;
  isPaused?: boolean;
  onTogglePause?: () => void;
  onManualRefresh?: () => void;
  isNewMode?: boolean;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  isContextStale,
  timeUntilRefresh,
  isPaused,
  onTogglePause,
  onManualRefresh,
  isNewMode
}) => {
  const showRefreshIndicator = !!onManualRefresh && !isNewMode;

  return (
    <div className="pt-3 sm:pt-4 border-t border-gray-200">
      <div className="flex items-center justify-between">
        <span className="hidden sm:inline text-gray-500">
          {isNewMode
            ? 'Cost estimate will be available after entering a prompt'
            : 'Enter a prompt to see cost estimate'}
        </span>
        <span className="sm:hidden text-gray-500 text-xs">
          {isNewMode ? 'Cost after entering prompt' : 'Enter prompt for cost'}
        </span>
        {showRefreshIndicator && (
          <RefreshIndicator
            isContextStale={isContextStale}
            timeUntilRefresh={timeUntilRefresh}
            isPaused={isPaused}
            onTogglePause={onTogglePause}
            onManualRefresh={onManualRefresh}
            isLoading={false}
          />
        )}
      </div>
    </div>
  );
};

interface RefreshIndicatorProps {
  isContextStale?: boolean;
  timeUntilRefresh?: number | null;
  isPaused?: boolean;
  onTogglePause?: () => void;
  onManualRefresh: () => void;
  isLoading: boolean;
}

const RefreshIndicator: React.FC<RefreshIndicatorProps> = ({
  timeUntilRefresh,
  isPaused,
  isContextStale,
  onTogglePause,
  onManualRefresh,
  isLoading
}) => {
  const getTooltipText = (): string => {
    if (isPaused) {
      return 'Auto-refresh is paused. Context will not update automatically when you make changes. Click the play button to resume.';
    }
    if (timeUntilRefresh !== null) {
      return 'Changes detected. Waiting before refresh to avoid rapid regeneration while you type. Click to refresh immediately.';
    }
    return 'Context is outdated. Click to regenerate based on your current prompt and settings.';
  };

  return (
    <div className="flex items-center gap-2 ml-4 flex-shrink-0 relative group/refresh">
      {/* Countdown timer - show when countdown active (both paused and not paused) */}
      {timeUntilRefresh !== null && (
        <span className={`text-xs flex items-center gap-1 ${isPaused ? 'text-amber-500' : 'text-gray-400'}`}>
          <Clock className="w-3 h-3" />
          {timeUntilRefresh}s
          {isPaused && <span className="ml-1">(paused)</span>}
        </span>
      )}
      {/* Paused indicator - only show when paused without active countdown */}
      {isPaused && isContextStale && timeUntilRefresh === null && (
        <span className="text-xs text-amber-500 flex items-center gap-1">
          <Pause className="w-3 h-3" />
          paused
        </span>
      )}
      {/* Pause/Resume button */}
      {onTogglePause && (
        <button
          onClick={onTogglePause}
          className={`p-1.5 rounded transition-colors ${
            isPaused
              ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-50'
              : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
          }`}
          title={isPaused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        >
          {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
        </button>
      )}
      {/* Manual refresh button - always enabled during countdown */}
      <button
        onClick={onManualRefresh}
        disabled={isLoading}
        className={`p-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          timeUntilRefresh !== null || isContextStale
            ? 'text-indigo-500 hover:text-indigo-600 hover:bg-indigo-50'
            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
        }`}
        title="Refresh context now"
      >
        <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
      </button>
      {/* Tooltip explaining the refresh logic */}
      <div className="absolute bottom-full right-0 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded shadow-lg opacity-0 group-hover/refresh:opacity-100 transition-opacity pointer-events-none w-64 z-50">
        <div className="font-medium mb-1">Context Refresh</div>
        <div className="text-gray-300 leading-relaxed">
          {getTooltipText()}
        </div>
        <div className="absolute bottom-0 right-4 transform translate-y-1/2 rotate-45 w-2 h-2 bg-gray-900"></div>
      </div>
    </div>
  );
};

interface CostPreviewContentProps {
  data: PreviewResult;
  contextRepositories?: ContextRepository[];
  isContextStale?: boolean;
  isLoading: boolean;
  hideCostsAndTokens?: boolean;
  hideRefreshControls?: boolean;
  timeUntilRefresh?: number | null;
  isPaused?: boolean;
  onTogglePause?: () => void;
  refreshHandler?: () => void;
}

interface CostStatsHeaderProps {
  stats: PreviewResult['stats'];
}

const CostStatsHeader: React.FC<CostStatsHeaderProps> = ({ stats }) => (
  <div className="flex items-baseline justify-between gap-3 text-xs">
    <span className="text-slate-500">
      <span className="font-semibold text-slate-700">{stats.totalTokens.toLocaleString()}</span> tokens
    </span>
    <span className="font-semibold tabular-nums text-slate-800">
      ${stats.costEstimate.toFixed(3)}
    </span>
  </div>
);

interface TokenUsageBarProps {
  usagePercentage: number;
  usageColor: string;
  maxTokens: number;
}

const TokenUsageBar: React.FC<TokenUsageBarProps> = ({ usagePercentage, usageColor, maxTokens }) => (
  <div className="space-y-1.5">
    <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${usageColor}`}
        style={{ width: `${usagePercentage}%` }}
      />
    </div>
    <div className="text-right text-[11px] leading-none text-slate-500 tabular-nums">
      {usagePercentage.toFixed(1)}% of {(maxTokens / 1000).toFixed(0)}k max
    </div>
  </div>
);

const CostPreviewContent: React.FC<CostPreviewContentProps> = ({
  data,
  contextRepositories,
  isContextStale,
  isLoading,
  hideCostsAndTokens,
  hideRefreshControls,
  timeUntilRefresh,
  isPaused,
  onTogglePause,
  refreshHandler,
}) => {
  const { stats, warnings } = data;
  const maxTokens = stats.maxTokens || 200000;
  const usagePercentage = Math.min(100, (stats.totalTokens / maxTokens) * 100);
  const actualPercentage = (stats.totalTokens / maxTokens) * 100;
  const usageColor = getUsageColor(usagePercentage, actualPercentage);
  const showRefreshIndicator = !!refreshHandler;

  return (
    <div className="pt-3 border-t border-gray-200 space-y-3">
      {!hideCostsAndTokens && (
        <div className="space-y-1.5">
          <CostStatsHeader stats={stats} />
          <TokenUsageBar usagePercentage={usagePercentage} usageColor={usageColor} maxTokens={maxTokens} />
        </div>
      )}
      {contextRepositories && contextRepositories.length > 0 && (
        <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
          <BookOpen className="w-4 h-4 text-blue-500" />
          <span className="text-sm text-gray-600">
            Including context from {contextRepositories.length} additional
            {contextRepositories.length === 1 ? ' repository' : ' repositories'}
          </span>
        </div>
      )}
      {(warnings.length > 0 || showRefreshIndicator) && (
        <div className="flex items-center justify-between gap-2 bg-slate-50 border-t border-slate-200 pt-2 text-xs text-slate-500">
          <div className="space-y-1 min-w-0 flex-1">
            {warnings.map((warning, idx) => (
              <div key={idx} className="flex items-center gap-1.5 min-w-0">
                <Info className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                <span className="block min-w-0 truncate" title={warning}>{warning}</span>
              </div>
            ))}
          </div>
          {showRefreshIndicator && (
            <RefreshIndicator
              isContextStale={isContextStale}
              timeUntilRefresh={hideRefreshControls ? null : timeUntilRefresh}
              isPaused={isPaused}
              onTogglePause={hideRefreshControls ? undefined : onTogglePause}
              onManualRefresh={refreshHandler}
              isLoading={isLoading}
            />
          )}
        </div>
      )}
    </div>
  );
};

export const CostPreview: React.FC<CostPreviewProps> = ({
  preview,
  contextRepositories,
  isContextStale,
  timeUntilRefresh,
  onManualRefresh,
  isPaused,
  onTogglePause,
  isNewMode,
  previewTrace,
  showPreviewProgress = true,
  hideCostsAndTokens,
  hideRefreshControls
}) => {
  if (preview.isLoading && showPreviewProgress) return <LoadingState previewTrace={previewTrace} />;
  if (preview.isLoading) return hideCostsAndTokens ? null : <DeferredLoadingState />;
  if (preview.error) return <ErrorState error={preview.error} />;
  const refreshHandler = hideRefreshControls ? undefined : onManualRefresh;
  if (!preview.data) return (
    hideCostsAndTokens ? null : (
      <EmptyState
        isContextStale={isContextStale}
        timeUntilRefresh={hideRefreshControls ? null : timeUntilRefresh}
        isPaused={isPaused}
        onTogglePause={hideRefreshControls ? undefined : onTogglePause}
        onManualRefresh={refreshHandler}
        isNewMode={isNewMode}
      />
    )
  );

  return (
    <CostPreviewContent
      data={preview.data}
      contextRepositories={contextRepositories}
      isContextStale={isContextStale}
      isLoading={preview.isLoading}
      hideCostsAndTokens={hideCostsAndTokens}
      hideRefreshControls={hideRefreshControls}
      timeUntilRefresh={timeUntilRefresh}
      isPaused={isPaused}
      onTogglePause={onTogglePause}
      refreshHandler={refreshHandler}
    />
  );
};
