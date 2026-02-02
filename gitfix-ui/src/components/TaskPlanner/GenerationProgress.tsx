import React, { useState } from 'react';
import { GenerationTrace } from '../../api/gitfixApi';

interface GenerationProgressProps {
  trace?: GenerationTrace;
  onAbort?: () => Promise<void>;
}

const STEP_LABELS: Record<string, string> = {
  llm: 'Generating Plan'
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
      <svg className="animate-spin w-5 h-5 text-indigo-600" viewBox="0 0 24 24">
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
      return 'bg-indigo-100 text-indigo-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-600';
  }
};

export const GenerationProgress: React.FC<GenerationProgressProps> = ({ trace, onAbort }) => {
  const [isAborting, setIsAborting] = useState(false);

  if (!trace || !trace.steps || trace.steps.length === 0) return null;

  const visibleSteps = trace.steps.filter(step => step.name === 'llm');

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
          <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        {visibleSteps.map((step) => (
          <div key={step.name} className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <StatusIcon status={step.status} />
                <span className="font-medium text-gray-900">
                  {STEP_LABELS[step.name] || step.name}
                </span>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${getStatusBadgeClass(step.status)}`}>
                {step.status === 'in_progress' ? 'In Progress' : step.status}
              </span>
            </div>

            {step.name === 'llm' && step.status === 'in_progress' && (
              <div className="text-sm text-gray-500 ml-8 italic">
                AI is analyzing the context and generating the implementation plan...
              </div>
            )}

            {step.status === 'failed' && (
               <div className="text-sm text-red-600 ml-8 mt-1">
                 Generation failed. Please try again.
               </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default GenerationProgress;
