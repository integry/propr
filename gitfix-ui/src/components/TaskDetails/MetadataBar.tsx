import React from 'react';
import { TaskInfo, HistoryItem } from './types';

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
  onViewLogs
}) => {
  const isActive = ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus);

  return (
    <div className="flex justify-between items-center mb-6 p-4 bg-gray-50 rounded-md border border-gray-200">
      <div className="flex items-center gap-4 flex-wrap">
        {isActive && (
          <>
            <button
              onClick={onStopExecution}
              disabled={stoppingExecution}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                stoppingExecution
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-red-600 text-white hover:bg-red-700'
              }`}
            >
              {stoppingExecution ? 'Stopping...' : 'Stop Execution'}
            </button>
            <span className="text-gray-400 hidden md:inline">|</span>
          </>
        )}
        {taskInfo && (
          <>
            <span className="text-gray-700 font-semibold">Repository:</span>
            <a
              href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-700 underline"
            >
              {taskInfo.repoOwner}/{taskInfo.repoName}
            </a>
            <span className="text-gray-400">•</span>
            <span className="text-gray-700 font-semibold">
              {taskInfo.type === 'pr-comment' ? 'Pull Request:' : 'Issue:'}
            </span>
            <a
              href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/${taskInfo.type === 'pr-comment' ? 'pull' : 'issues'}/${taskInfo.number}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-700 underline"
            >
              #{taskInfo.number}
            </a>
          </>
        )}
        <span className="text-gray-400">•</span>
        <span className="text-gray-700 font-semibold">Model:</span>
        <span className="text-blue-600">{modelName}</span>
        {prInfo?.url && (
          <>
            <span className="text-gray-400">•</span>
            <span className="text-gray-700 font-semibold">Pull Request:</span>
            <a
              href={prInfo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-700 underline"
            >
              #{prInfo.number}
            </a>
          </>
        )}
      </div>
      <div className="flex gap-2">
        {historyItemWithPaths?.promptPath && (
          <button
            onClick={() => onViewPrompt(historyItemWithPaths.promptPath!)}
            className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
          >
            View Prompt
          </button>
        )}
        {historyItemWithPaths?.logsPath && (
          <button
            onClick={() => onViewLogs(historyItemWithPaths.logsPath!)}
            className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition-colors"
          >
            View Log Files
          </button>
        )}
      </div>
    </div>
  );
};

export default MetadataBar;
