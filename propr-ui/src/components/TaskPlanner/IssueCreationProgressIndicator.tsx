import React from 'react';
import { motion } from 'framer-motion';
import { Loader2, CheckCircle, AlertCircle, Github, X } from 'lucide-react';
import { IssueCreationProgress } from './usePlanIssuesManager';

interface IssueCreationProgressIndicatorProps {
  progress: IssueCreationProgress;
  onDismiss?: () => void;
}

export const IssueCreationProgressIndicator: React.FC<IssueCreationProgressIndicatorProps> = ({ progress, onDismiss }) => {
  if (progress.status === 'idle') return null;

  const getStatusColor = () => {
    switch (progress.status) {
      case 'in_progress': return 'bg-blue-50 border-blue-200';
      case 'completed': return 'bg-green-50 border-green-200';
      case 'failed': return 'bg-red-50 border-red-200';
      default: return 'bg-gray-50 border-gray-200';
    }
  };

  const getStatusIcon = () => {
    switch (progress.status) {
      case 'in_progress':
        return <Loader2 size={18} className="text-blue-600 animate-spin" />;
      case 'completed':
        return <CheckCircle size={18} className="text-green-600" />;
      case 'failed':
        return <AlertCircle size={18} className="text-red-600" />;
      default:
        return null;
    }
  };

  const getMessage = () => {
    if (progress.status === 'in_progress') {
      if (progress.totalCount > 0) {
        return `Creating issue ${progress.createdCount + 1} of ${progress.totalCount}...`;
      }
      return 'Creating GitHub issues...';
    }
    if (progress.status === 'completed') {
      if (progress.failedCount > 0) {
        return `Created ${progress.createdCount} of ${progress.totalCount} issues (${progress.failedCount} failed)`;
      }
      return `Successfully created ${progress.createdCount} GitHub issue${progress.createdCount !== 1 ? 's' : ''}`;
    }
    if (progress.status === 'failed') {
      return progress.error || 'Failed to create issues';
    }
    return '';
  };

  const progressPercentage = progress.totalCount > 0
    ? Math.round((progress.createdCount / progress.totalCount) * 100)
    : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`flex items-center gap-3 p-3 rounded-lg border ${getStatusColor()} mb-4`}
    >
      <div className="flex-shrink-0">
        {getStatusIcon()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Github size={14} className="text-gray-500 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-800">{getMessage()}</span>
        </div>
        {progress.status === 'in_progress' && progress.totalCount > 0 && (
          <div className="mt-2">
            <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-blue-500 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${progressPercentage}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            {progress.lastCreatedIssue && (
              <p className="text-xs text-gray-500 mt-1 truncate">
                Last created: #{progress.lastCreatedIssue.number} - {progress.lastCreatedIssue.title}
              </p>
            )}
          </div>
        )}
      </div>
      {(progress.status === 'completed' || progress.status === 'failed') && onDismiss && (
        <button
          onClick={onDismiss}
          className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
          title="Dismiss"
        >
          <X size={16} />
        </button>
      )}
    </motion.div>
  );
};

export default IssueCreationProgressIndicator;
