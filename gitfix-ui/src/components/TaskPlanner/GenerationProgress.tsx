import React, { useState, useEffect, useMemo } from 'react';
import { GenerationTrace } from '../../api/gitfixApi';

interface GenerationProgressProps {
  trace?: GenerationTrace;
  onAbort?: () => Promise<void>;
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
const MAX_PROGRESS_PERCENT = 98;

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
    return (
      <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg className="animate-spin w-5 h-5" style={{ color: 'rgb(29, 138, 138)' }} viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return (
    <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
  );
};

const getStatusBadgeClass = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800';
    case 'in_progress':
      return 'bg-teal-100 text-teal-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-600';
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

  const startTime = useMemo(() => new Date(startedAt).getTime(), [startedAt]);

  useEffect(() => {
    if (isCompleted) {
      setProgress(100);
      return;
    }

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
  const isOverEstimate = elapsed > estimatedDuration;

  return (
    <div className="ml-8 mt-3">
      {/* Progress bar */}
      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-500 ease-out rounded-full"
          style={{
            width: `${progress}%`,
            backgroundColor: isOverEstimate ? 'rgb(234, 179, 8)' : 'rgb(29, 138, 138)'
          }}
        />
      </div>
      {/* Progress info */}
      <div className="flex justify-between mt-1.5 text-xs text-gray-500">
        <span>
          {isCompleted ? (
            'Complete'
          ) : isOverEstimate ? (
            <span className="text-yellow-600">Taking longer than expected...</span>
          ) : (
            `~${formatDuration(remaining)} remaining`
          )}
        </span>
        <span>{Math.round(progress)}%</span>
      </div>
    </div>
  );
};

export const GenerationProgress: React.FC<GenerationProgressProps> = ({ trace, onAbort }) => {
  const [isAborting, setIsAborting] = useState(false);

  if (!trace || !trace.steps || trace.steps.length === 0) return null;

  const visibleSteps = trace.steps.filter(step => ['relevance', 'context', 'llm'].includes(step.name));

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
    <div className="mt-6 border rounded-lg overflow-hidden bg-gray-50">
      <div className="p-4 bg-gray-100 font-semibold border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5" style={{ color: 'rgb(29, 138, 138)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          Generation Progress
        </div>
        {isGenerating && onAbort && (
          <button
            onClick={handleAbort}
            disabled={isAborting}
            className="px-3 py-1 text-sm font-medium text-red-700 bg-red-100 hover:bg-red-200 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {isAborting ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Stopping...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Stop
              </>
            )}
          </button>
        )}
      </div>
      <div className="divide-y">
        {visibleSteps.map((step) => {
          const hasProgressData = step.data?.estimatedDuration && step.data?.startedAt;
          const showProgressBar = ['relevance', 'context', 'llm'].includes(step.name) && (step.status === 'in_progress' || step.status === 'completed') && hasProgressData;

          return (
            <div key={step.name} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <StatusIcon status={step.status} />
                  <span className="font-medium text-gray-900">
                    {STEP_LABELS[step.name] || step.name}
                  </span>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${getStatusBadgeClass(step.status)}`}>
                  {step.status === 'in_progress' ? 'In Progress' : step.status === 'pending' ? 'Pending' : step.status}
                </span>
              </div>

              {step.status === 'pending' && (
                <div className="text-sm text-gray-400 ml-8 italic">
                  {STEP_PENDING_DESCRIPTIONS[step.name] || 'Waiting to start...'}
                </div>
              )}

              {step.status === 'in_progress' && !hasProgressData && (
                <div className="text-sm text-gray-500 ml-8 italic">
                  {STEP_DESCRIPTIONS[step.name] || 'Processing...'}
                </div>
              )}

              {showProgressBar && (
                <ProgressBar
                  estimatedDuration={step.data!.estimatedDuration!}
                  startedAt={step.data!.startedAt!}
                  isCompleted={step.status === 'completed'}
                />
              )}

              {step.status === 'failed' && (
                 <div className="text-sm text-red-600 ml-8 mt-1">
                   Generation failed. Please try again.
                 </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default GenerationProgress;
