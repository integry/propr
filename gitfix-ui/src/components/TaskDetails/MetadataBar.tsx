import React from 'react';
import { TaskInfo, HistoryItem } from './types';
import { FileText, Terminal, Square, Clock, ExternalLink, GitPullRequest } from 'lucide-react';
import { formatRelativeTime } from './utils';
import { ProviderLogo } from '../ui/ProviderLogo';

// GitHub icon component
const GitHubIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
  </svg>
);

// Model name mapping for human-readable names
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-opus-4-5-20251101': 'Claude Opus 4.5',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
  'claude-3-opus-20240229': 'Claude 3 Opus',
  'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
  'claude-3-haiku-20240307': 'Claude 3 Haiku',
};

const getDisplayModelName = (modelId: string): string => {
  return MODEL_DISPLAY_NAMES[modelId] || modelId;
};

// Vertical divider component for consistent styling
const Divider: React.FC = () => (
  <div className="h-4 w-px bg-gray-300 hidden sm:block" />
);

// Repository link component
const RepoLink: React.FC<{ taskInfo: TaskInfo }> = ({ taskInfo }) => (
  <div className="flex items-center gap-1.5">
    <GitHubIcon size={16} className="text-gray-700 hidden sm:block" />
    <a
      href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-gray-900 hover:text-blue-600 transition-colors text-xs sm:text-sm"
    >
      {taskInfo.repoOwner}/{taskInfo.repoName}
    </a>
  </div>
);

// Issue/PR link component
const IssueLink: React.FC<{ taskInfo: TaskInfo }> = ({ taskInfo }) => (
  <a
    href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/${taskInfo.type === 'pr-comment' ? 'pull' : 'issues'}/${taskInfo.number}`}
    target="_blank"
    rel="noopener noreferrer"
    className="flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium text-xs sm:text-sm"
    title={taskInfo.type === 'pr-comment' ? `Pull Request #${taskInfo.number}` : `Issue #${taskInfo.number}`}
  >
    <GitHubIcon size={14} className="text-blue-600" />
    {taskInfo.type === 'pr-comment' ? `PR #${taskInfo.number}` : `#${taskInfo.number}`}
    <ExternalLink size={12} aria-hidden="true" className="hidden sm:block" />
  </a>
);

// Linked issue component for PR tasks
const LinkedIssue: React.FC<{ taskInfo: TaskInfo }> = ({ taskInfo }) => {
  if (taskInfo.type !== 'pr-comment' || !taskInfo.issueNumber) return null;
  return (
    <>
      <Divider />
      <a
        href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/issues/${taskInfo.issueNumber}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-orange-600 hover:text-orange-700 font-medium text-xs sm:text-sm"
        title={`Original Issue #${taskInfo.issueNumber}`}
      >
        <GitHubIcon size={14} className="text-orange-600" />
        Issue #{taskInfo.issueNumber}
        <ExternalLink size={12} aria-hidden="true" className="hidden sm:block" />
      </a>
    </>
  );
};

// PR info link component
const PRInfoLink: React.FC<{ prInfo: { url?: string; number?: number } | undefined }> = ({ prInfo }) => {
  if (!prInfo?.url) return null;
  return (
    <>
      <Divider />
      <a
        href={prInfo.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-green-600 hover:text-green-700 font-medium text-xs sm:text-sm"
      >
        <GitPullRequest size={14} aria-hidden="true" />
        PR #{prInfo.number}
        <ExternalLink size={12} aria-hidden="true" className="hidden sm:block" />
      </a>
    </>
  );
};

interface MetadataBarProps {
  taskInfo: TaskInfo | null;
  currentStatus: string;
  modelName: string;
  prInfo: { url?: string; number?: number } | undefined;
  historyItemWithPaths: HistoryItem | undefined;
  stoppingExecution: boolean;
  onStopExecution: () => void;
  onViewPrompt: (promptPath: string) => void;
  onViewLogs: (logsPath: string) => void;
  duration?: number | null;
  stats?: {
    filesChanged?: number;
    linesChanged?: number;
  };
}

const MetadataBar: React.FC<MetadataBarProps> = ({
  taskInfo,
  currentStatus,
  modelName,
  prInfo,
  historyItemWithPaths,
  stoppingExecution,
  onStopExecution,
  onViewPrompt,
  onViewLogs,
  duration,
  stats
}) => {
  const isActive = ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus);
  const hasDuration = duration !== null && duration !== undefined;

  return (
    <div className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm px-3 sm:px-4 py-2 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 sm:gap-3">
      {/* Left: Context */}
      <div className="flex items-center gap-2 sm:gap-3 text-sm flex-wrap w-full sm:w-auto">
        {/* Repository & Issue/PR grouped together */}
        {taskInfo && (
          <>
            <RepoLink taskInfo={taskInfo} />
            <Divider />
            <IssueLink taskInfo={taskInfo} />
            <LinkedIssue taskInfo={taskInfo} />
          </>
        )}

        <Divider />

        {/* Model with distinct style */}
        <span
          className="flex items-center gap-1.5 bg-purple-50 text-purple-700 px-2 py-0.5 rounded text-xs font-medium border border-purple-100 cursor-default"
          title={modelName}
        >
          <ProviderLogo provider={modelName} className="w-3.5 h-3.5" />
          {getDisplayModelName(modelName)}
        </span>

        {/* PR info if available */}
        <PRInfoLink prInfo={prInfo} />

        {/* Duration/Timestamps */}
        {hasDuration && (
          <>
            <Divider />
            <span className="flex items-center gap-1 text-gray-600 text-xs sm:text-sm">
              <Clock size={14} />
              {formatRelativeTime(duration)}
            </span>
          </>
        )}

        {/* Stats Display (from RealTimeStats) */}
        {stats && (
          <>
            <Divider />
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>Files: {stats.filesChanged ?? '-'}</span>
              <span>Lines: {stats.linesChanged ?? '-'}</span>
            </div>
          </>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2 self-end sm:self-auto">
        {/* Stop Execution Button - Red background to distinguish from navigation */}
        {isActive && (
          <button
            onClick={onStopExecution}
            disabled={stoppingExecution}
            title={stoppingExecution ? 'Stopping execution...' : 'Stop Execution'}
            className={`p-1.5 sm:p-2 rounded transition-colors ${
              stoppingExecution
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-red-100 hover:bg-red-200 text-red-600 hover:text-red-700 border border-red-200'
            }`}
          >
            <Square size={16} className="sm:w-[18px] sm:h-[18px]" fill={stoppingExecution ? 'currentColor' : 'none'} />
          </button>
        )}

        {/* View Prompt Button */}
        {historyItemWithPaths?.promptPath && (
          <button
            onClick={() => onViewPrompt(historyItemWithPaths.promptPath!)}
            title="View Prompt - View the original prompt sent to the AI"
            className="p-1.5 sm:p-2 hover:bg-blue-50 rounded text-blue-600 hover:text-blue-700 transition-colors"
          >
            <FileText size={16} className="sm:w-[18px] sm:h-[18px]" />
          </button>
        )}

        {/* View Logs Button */}
        {historyItemWithPaths?.logsPath && (
          <button
            onClick={() => onViewLogs(historyItemWithPaths.logsPath!)}
            title="View Logs - View execution logs and terminal output"
            className="p-1.5 sm:p-2 hover:bg-green-50 rounded text-green-600 hover:text-green-700 transition-colors"
          >
            <Terminal size={16} className="sm:w-[18px] sm:h-[18px]" />
          </button>
        )}
      </div>
    </div>
  );
};

export default MetadataBar;
