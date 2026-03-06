import React, { useState, useEffect, useMemo } from 'react';
import { GenerationTrace } from '../../api/proprApi';

interface GenerationProgressProps {
  trace?: GenerationTrace;
  onAbort?: () => Promise<void>;
  /**
   * When true, hides completed steps since the result will be shown immediately after.
   * Used for cost preview context gathering where showing "completed" is redundant.
   */
  hideCompletedSteps?: boolean;
}

const STEP_LABELS: Record<string, string> = {
  relevance: 'Analyzing Relevance',
  context: 'Gathering Context',
  llm: 'Generating Plan'
};

const STEP_DESCRIPTIONS: Record<string, string> = {
  relevance: 'Identifying relevant files and analyzing codebase structure...',
  context: 'Compiling source code context from selected files...',
  llm: 'AI is analyzing the context and generating the implementation plan...'
};

const STEP_PENDING_DESCRIPTIONS: Record<string, string> = {
  relevance: 'Will analyze codebase to identify relevant files',
  context: 'Will compile source code from selected files',
  llm: 'Will analyze context and generate implementation plan'
};

/** Maximum progress percentage to show when execution takes longer than estimated */
const MAX_PROGRESS_PERCENT = 95;

/** Minimum time to show a step before transitioning to completed (ms) */
const MIN_VISIBLE_DURATION_MS = 500;

/** Format duration for display (e.g., "1m 30s") */
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
};

const StatusIcon: React.FC<{ status: string }> = ({ status }) => {
  if (status === 'completed') {
    // Success is quiet - gray checkmark per design guidelines
    return (
      <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg className="animate-spin w-4 h-4" style={{ color: 'rgb(29, 138, 138)' }} viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return (
    <div className="w-4 h-4 rounded-full border-2 border-slate-300" />
  );
};

const getStatusBadgeClass = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'text-slate-500'; // Success is quiet - gray per design guidelines
    case 'in_progress':
      return 'bg-teal-50 text-teal-700 border border-teal-200'; // Active state - Brand Teal
    case 'failed':
      return 'text-red-600'; // Failed - Red text per guidelines
    default:
      return 'text-slate-400'; // Pending - subtle
  }
};

interface ProgressBarProps {
  estimatedDuration: number;
  startedAt: string;
  isCompleted: boolean;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ estimatedDuration, startedAt, isCompleted }) => {
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [showComplete, setShowComplete] = useState(false);

  const startTime = useMemo(() => new Date(startedAt).getTime(), [startedAt]);

  useEffect(() => {
    if (isCompleted) {
      // Ensure the progress bar is visible for at least MIN_VISIBLE_DURATION_MS
      // before showing the completed state to avoid jarring transitions
      const now = Date.now();
      const elapsedMs = now - startTime;
      const remainingVisibleTime = Math.max(0, MIN_VISIBLE_DURATION_MS - elapsedMs);

      if (remainingVisibleTime > 0) {
        // Show high progress while waiting
        setProgress(95);
        const timer = setTimeout(() => {
          setProgress(100);
          setShowComplete(true);
        }, remainingVisibleTime);
        return () => clearTimeout(timer);
      } else {
        setProgress(100);
        setShowComplete(true);
      }
      return;
    }

    setShowComplete(false);

    const updateProgress = () => {
      const now = Date.now();
      const elapsedMs = now - startTime;
      setElapsed(elapsedMs);

      // Calculate progress percentage, capped at MAX_PROGRESS_PERCENT until completion
      const rawProgress = (elapsedMs / estimatedDuration) * 100;
      setProgress(Math.min(rawProgress, MAX_PROGRESS_PERCENT));
    };

    // Update immediately
    updateProgress();

    // Update every 500ms for smooth progress
    const interval = setInterval(updateProgress, 500);

    return () => clearInterval(interval);
  }, [startTime, estimatedDuration, isCompleted]);

  const remaining = Math.max(0, estimatedDuration - elapsed);
  // Only show "Taking longer than expected" after exceeding estimate by 10%
  const isOverEstimate = elapsed > estimatedDuration * 1.1;

  return (
    <div className="ml-6 mt-2">
      {/* Progress bar */}
      <div className="w-full h-1.5 bg-slate-200 rounded-sm overflow-hidden">
        <div
          className="h-full transition-all duration-500 ease-out"
          style={{
            width: `${progress}%`,
            backgroundColor: isOverEstimate ? 'rgb(234, 179, 8)' : 'rgb(29, 138, 138)'
          }}
        />
      </div>
      {/* Progress info */}
      <div className="flex justify-between mt-1 text-xs text-slate-500">
        <span>
          {showComplete ? (
            'Complete'
          ) : isOverEstimate ? (
            <span className="text-amber-600">Taking longer than expected...</span>
          ) : (
            `~${formatDuration(remaining)} remaining`
          )}
        </span>
        <span>{Math.round(progress)}%</span>
      </div>
    </div>
  );
};

/**
 * StepItem component that maintains stable progress state to prevent flickering.
 * Uses local state to track progress data even when the step transitions to completed.
 */
const StepItem: React.FC<{
  step: GenerationTrace['steps'][0];
}> = ({ step }) => {
  // Cache progress data to avoid flickering when step transitions to completed
  // This ensures the progress bar smoothly transitions instead of disappearing
  const [cachedProgressData, setCachedProgressData] = useState<{
    estimatedDuration: number;
    startedAt: string;
  } | null>(null);

  useEffect(() => {
    // Update cached data when new progress data becomes available
    if (step.data?.estimatedDuration && step.data?.startedAt) {
      setCachedProgressData({
        estimatedDuration: step.data.estimatedDuration as number,
        startedAt: step.data.startedAt as string
      });
    }
  }, [step.data?.estimatedDuration, step.data?.startedAt]);

  const hasProgressData = cachedProgressData !== null;
  const showProgressBar = ['relevance', 'context', 'llm'].includes(step.name) &&
    (step.status === 'in_progress' || step.status === 'completed') &&
    hasProgressData;

  // For in_progress without data yet, show a simple indeterminate progress bar
  // This provides consistent visual feedback without the jarring switch from description to progress bar
  const showIndeterminateProgress = step.status === 'in_progress' && !hasProgressData;

  return (
    <div className="py-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <StatusIcon status={step.status} />
          <span className="text-sm font-medium text-slate-900">
            {STEP_LABELS[step.name] || step.name}
          </span>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${getStatusBadgeClass(step.status)}`}>
          {step.status === 'in_progress' ? 'In Progress' : step.status === 'pending' ? 'Pending' : step.status}
        </span>
      </div>

      {step.status === 'pending' && (
        <div className="text-xs text-slate-400 ml-6 italic">
          {STEP_PENDING_DESCRIPTIONS[step.name] || 'Waiting to start...'}
        </div>
      )}

      {showIndeterminateProgress && (
        <div className="ml-6 mt-2">
          <div className="text-xs text-slate-500 mb-1.5 italic">
            {STEP_DESCRIPTIONS[step.name] || 'Processing...'}
          </div>
          {/* Indeterminate progress bar animation */}
          <div className="w-full h-1.5 bg-slate-200 rounded-sm overflow-hidden">
            <div
              className="h-full animate-pulse"
              style={{
                width: '30%',
                backgroundColor: 'rgb(29, 138, 138)',
                animation: 'indeterminate 1.5s ease-in-out infinite'
              }}
            />
          </div>
          <style>{`
            @keyframes indeterminate {
              0% { margin-left: 0%; width: 30%; }
              50% { margin-left: 35%; width: 30%; }
              100% { margin-left: 70%; width: 30%; }
            }
          `}</style>
        </div>
      )}

      {showProgressBar && (
        <ProgressBar
          estimatedDuration={cachedProgressData!.estimatedDuration}
          startedAt={cachedProgressData!.startedAt}
          isCompleted={step.status === 'completed'}
        />
      )}

      {step.status === 'failed' && (
        <div className="text-xs text-red-600 ml-6 mt-1">
          Generation failed. Please try again.
        </div>
      )}
    </div>
  );
};

export const GenerationProgress: React.FC<GenerationProgressProps> = ({ trace, onAbort, hideCompletedSteps = false }) => {
  const [isAborting, setIsAborting] = useState(false);

  if (!trace || !trace.steps || trace.steps.length === 0) return null;

  let visibleSteps = trace.steps.filter(step => ['relevance', 'context', 'llm'].includes(step.name));

  // When hideCompletedSteps is true (used for preview), filter out completed steps
  // This prevents showing a brief "completed" state before the result appears
  if (hideCompletedSteps) {
    visibleSteps = visibleSteps.filter(step => step.status !== 'completed');
  }

  if (visibleSteps.length === 0) return null;

  const isGenerating = visibleSteps.some(step => step.status === 'in_progress');

  const handleAbort = async () => {
    if (!onAbort || isAborting) return;
    setIsAborting(true);
    try {
      await onAbort();
    } finally {
      setIsAborting(false);
    }
  };

  return (
    <div className="mt-4">
      <div className="pb-3 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4" style={{ color: 'rgb(29, 138, 138)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="text-sm font-medium text-slate-700">Generation Progress</span>
        </div>
        {isGenerating && onAbort && (
          <button
            onClick={handleAbort}
            disabled={isAborting}
            className="px-2 py-0.5 text-xs font-medium text-red-700 hover:text-red-800 hover:bg-red-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            {isAborting ? (
              <>
                <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Stopping...
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Stop
              </>
            )}
          </button>
        )}
      </div>
      <div className="divide-y divide-slate-100">
        {visibleSteps.map((step) => (
          <StepItem key={step.name} step={step} />
        ))}
      </div>
    </div>
  );
};

export default GenerationProgress;
