import React from 'react';
import { TaskInfo, HistoryItem } from './types';
import { FileText, Terminal, Square, Clock, ExternalLink } from 'lucide-react';
import { formatRelativeTime } from './utils';

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
  duration
}) => {
  const isActive = ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus);

  return (
    <div className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm px-4 py-2 flex justify-between items-center">
      {/* Left: Context */}
      <div className="flex items-center gap-3 text-sm flex-wrap">
        {/* Repository & Issue/PR grouped together */}
        {taskInfo && (
          <div className="flex items-center gap-1">
            <a
              href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-gray-900 hover:text-blue-600 transition-colors"
            >
              {taskInfo.repoOwner}/{taskInfo.repoName}
            </a>
            <a
              href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/${taskInfo.type === 'pr-comment' ? 'pull' : 'issues'}/${taskInfo.number}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              #{taskInfo.number}
            </a>
          </div>
        )}

        <div className="h-4 w-px bg-gray-300" />

        {/* Model with distinct style */}
        <span className="flex items-center gap-1 bg-purple-50 text-purple-700 px-2 py-0.5 rounded text-xs font-medium border border-purple-100">
          {modelName}
        </span>

        {/* PR info if available */}
        {prInfo?.url && (
          <>
            <div className="h-4 w-px bg-gray-300" />
            <a
              href={prInfo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-green-600 hover:text-green-700 font-medium"
            >
              PR #{prInfo.number}
              <ExternalLink size={12} />
            </a>
          </>
        )}

        {/* Duration/Timestamps */}
        {duration !== null && duration !== undefined && (
          <>
            <div className="h-4 w-px bg-gray-300" />
            <span className="flex items-center gap-1 text-gray-600">
              <Clock size={14} />
              {formatRelativeTime(duration)}
            </span>
          </>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {/* Stop Execution Button */}
        {isActive && (
          <button
            onClick={onStopExecution}
            disabled={stoppingExecution}
            title={stoppingExecution ? 'Stopping...' : 'Stop Execution'}
            className={`p-2 rounded transition-colors ${
              stoppingExecution
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'hover:bg-red-50 text-red-600 hover:text-red-700'
            }`}
          >
            <Square size={18} fill={stoppingExecution ? 'currentColor' : 'none'} />
          </button>
        )}

        {/* View Prompt Button */}
        {historyItemWithPaths?.promptPath && (
          <button
            onClick={() => onViewPrompt(historyItemWithPaths.promptPath!)}
            title="View Prompt"
            className="p-2 hover:bg-blue-50 rounded text-blue-600 hover:text-blue-700 transition-colors"
          >
            <FileText size={18} />
          </button>
        )}

        {/* View Logs Button */}
        {historyItemWithPaths?.logsPath && (
          <button
            onClick={() => onViewLogs(historyItemWithPaths.logsPath!)}
            title="View Logs"
            className="p-2 hover:bg-green-50 rounded text-green-600 hover:text-green-700 transition-colors"
          >
            <Terminal size={18} />
          </button>
        )}
      </div>
    </div>
  );
};

export default MetadataBar;
