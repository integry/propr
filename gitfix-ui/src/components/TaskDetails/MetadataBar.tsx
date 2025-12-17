import React, { useMemo } from 'react';
import { TaskInfo, HistoryItem } from './types';
import { FileText, Terminal, StopCircle } from 'lucide-react';

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
  startTime?: string;
  endTime?: string;
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
  startTime,
  endTime
}) => {
  const isActive = ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus);

  const duration = useMemo(() => {
    if (!startTime) return null;
    const start = new Date(startTime).getTime();
    const end = endTime ? new Date(endTime).getTime() : new Date().getTime();
    const diff = end - start;
    
    if (diff < 0) return null;

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }, [startTime, endTime]);

  return (
    <div className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm px-4 py-2 flex justify-between items-center">
      {/* Left: Context */}
      <div className="flex items-center gap-3 text-sm">
        {taskInfo && (
          <>
            <span className="font-semibold text-gray-900">
              {taskInfo.repoOwner}/{taskInfo.repoName}
            </span>
            <span className="text-gray-400">#</span>
            <a
              href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/${taskInfo.type === 'pr-comment' ? 'pull' : 'issues'}/${taskInfo.number}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              {taskInfo.number}
            </a>
          </>
        )}
        <div className="h-4 w-px bg-gray-300 mx-2" />
        <span className="flex items-center gap-1 bg-purple-50 text-purple-700 px-2 py-0.5 rounded text-xs border border-purple-100">
          {modelName}
        </span>
        {prInfo?.url && (
            <>
                <div className="h-4 w-px bg-gray-300 mx-2" />
                <span className="text-gray-500 text-xs">PR: </span>
                <a
                href={prInfo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-xs"
                >
                #{prInfo.number}
                </a>
            </>
        )}
        {duration && (
          <>
            <div className="h-4 w-px bg-gray-300 mx-2" />
            <span className="text-gray-500 text-xs">
              {duration}
            </span>
          </>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {isActive && (
          <button
            onClick={onStopExecution}
            disabled={stoppingExecution}
            title="Stop Execution"
            className={`p-2 rounded hover:bg-gray-100 ${stoppingExecution ? 'text-gray-400' : 'text-red-600'}`}
          >
            <StopCircle size={18} />
          </button>
        )}

        {historyItemWithPaths?.promptPath && (
          <button
            onClick={() => onViewPrompt(historyItemWithPaths.promptPath!)}
            title="View Prompt"
            className="p-2 hover:bg-gray-100 rounded text-gray-600"
          >
            <FileText size={18} />
          </button>
        )}
        {historyItemWithPaths?.logsPath && (
          <button
            onClick={() => onViewLogs(historyItemWithPaths.logsPath!)}
            title="View Logs"
            className="p-2 hover:bg-gray-100 rounded text-gray-600"
          >
            <Terminal size={18} />
          </button>
        )}
      </div>
    </div>
  );
};

export default MetadataBar;
