import React from 'react';
import { motion } from 'framer-motion';
import { Loader2, Check, AlertCircle, ExternalLink } from 'lucide-react';
import { IssueCreationProgress } from './usePlanIssuesManager';

interface IssueCreationProgressIndicatorProps {
  progress: IssueCreationProgress;
  onDismiss?: () => void;
  stableLayout?: boolean;
  spinnerRotationDegrees?: number;
}

const StatusIcon: React.FC<{ status: string; spinnerRotationDegrees?: number }> = ({ status, spinnerRotationDegrees }) => {
  if (status === 'in_progress') {
    return (
      <Loader2
        size={14}
        className={`text-blue-600 ${spinnerRotationDegrees === undefined ? 'animate-spin' : ''}`}
        style={spinnerRotationDegrees === undefined ? undefined : { transform: `rotate(${spinnerRotationDegrees}deg)` }}
      />
    );
  }
  if (status === 'completed') return <Check size={14} className="text-gray-400" />;
  return <AlertCircle size={14} className="text-red-500" />;
};

interface ProgressBarProps {
  progressPercentage: number;
  animated: boolean;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ progressPercentage, animated }) => (
  <div className="flex-1 h-1 bg-gray-200 rounded-full overflow-hidden max-w-[200px]">
    {animated ? (
      <motion.div
        className="h-full bg-blue-500 rounded-full"
        initial={{ width: 0 }}
        animate={{ width: `${progressPercentage}%` }}
        transition={{ duration: 0.3 }}
      />
    ) : (
      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${progressPercentage}%` }} />
    )}
  </div>
);

interface ProgressStatusTextProps {
  progress: IssueCreationProgress;
  progressPercentage: number;
}

const ProgressStatusText: React.FC<ProgressStatusTextProps> = ({ progress, progressPercentage }) => {
  if (progress.status === 'in_progress' && progress.totalCount > 0) {
    return (
      <>
        <ProgressBar progressPercentage={progressPercentage} animated={progress.animatedCreatedCount === undefined} />
        <span className="text-xs text-gray-500 tabular-nums">
          {progress.createdCount}/{progress.totalCount}
        </span>
      </>
    );
  }
  if (progress.status === 'completed') {
    return (
      <span className="text-xs text-gray-500">
        {progress.createdCount} issue{progress.createdCount !== 1 ? 's' : ''} created
      </span>
    );
  }
  return (
    <span className="text-xs text-red-600">
      {progress.error || 'Failed to create issues'}
    </span>
  );
};

export const IssueCreationProgressIndicator: React.FC<IssueCreationProgressIndicatorProps> = ({ progress, onDismiss, stableLayout = false, spinnerRotationDegrees }) => {
  if (progress.status === 'idle') return null;

  const progressCount = progress.animatedCreatedCount ?? progress.createdCount;
  const progressPercentage = progress.totalCount > 0
    ? Math.min(100, Math.max(0, (progressCount / progress.totalCount) * 100))
    : 0;
  const showDismiss = (progress.status === 'completed' || progress.status === 'failed') && onDismiss;

  const content = (
    <div className="flex items-center gap-3 h-8 px-2.5 py-1.5 bg-slate-50 rounded-md border border-slate-100">
      <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
        <StatusIcon status={progress.status} spinnerRotationDegrees={spinnerRotationDegrees} />
      </div>
      <div className="flex-1 flex items-center gap-3">
        <ProgressStatusText progress={progress} progressPercentage={progressPercentage} />
        {progress.lastCreatedIssue && progress.status === 'in_progress' && (
          <a
            href={progress.lastCreatedIssue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 rounded text-xs font-mono text-gray-600 transition-colors"
          >
            #{progress.lastCreatedIssue.number}
            <ExternalLink size={10} className="text-gray-400" />
          </a>
        )}
      </div>
      {showDismiss && (
        <button
          onClick={onDismiss}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          Dismiss
        </button>
      )}
    </div>
  );

  if (stableLayout) {
    return <div className="mb-3">{content}</div>;
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="mb-3"
    >
      {content}
    </motion.div>
  );
};

export default IssueCreationProgressIndicator;
