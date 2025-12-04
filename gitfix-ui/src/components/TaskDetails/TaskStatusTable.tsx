import React from 'react';
import { HistoryItem } from './types';
import { formatDate, formatRelativeTime } from './utils';

interface TaskStatusTableProps {
  history: HistoryItem[];
}

const getDisplayLabel = (item: HistoryItem, index: number, history: HistoryItem[]): React.ReactNode => {
  const stateUpper = item.state?.toUpperCase();
  let displayLabel: string | React.ReactNode = item.state?.replace(/_/g, ' ').toLowerCase() || '';
  
  if (stateUpper === 'PENDING') {
    displayLabel = 'Task Queued';
  } else if (stateUpper === 'PROCESSING') {
    displayLabel = 'Analyzing Request';
  } else if (stateUpper === 'CLAUDE_EXECUTION' || stateUpper === 'CLAUDE_EXECUTION_STARTED') {
    displayLabel = getClaudeExecutionLabel(item, index, history);
  } else if (stateUpper === 'CLAUDE_EXECUTION_COMPLETED') {
    displayLabel = 'Implementation Completed';
  } else if (stateUpper === 'POST_PROCESSING') {
    displayLabel = 'Creating Pull Request';
  } else if (stateUpper === 'COMPLETED') {
    displayLabel = 'Task Completed';
  } else if (stateUpper === 'FAILED') {
    displayLabel = 'Task Failed';
  }

  return appendPrLink(item, stateUpper, displayLabel);
};

const getClaudeExecutionLabel = (
  item: HistoryItem, 
  index: number, 
  history: HistoryItem[]
): string => {
  const claudeCount = history.slice(0, index + 1).filter(h => {
    const s = h.state?.toUpperCase();
    return s === 'CLAUDE_EXECUTION' || s === 'CLAUDE_EXECUTION_STARTED';
  }).length;
  
  if (item.reason?.toLowerCase().includes('completed')) {
    return 'Implementation Completed';
  }
  if (item.reason?.toLowerCase().includes('started')) {
    return claudeCount === 1 ? 'Implementing Changes' : `Retry Implementation ${claudeCount}`;
  }
  if (item.metadata?.description) {
    return item.metadata.description;
  }
  return claudeCount === 1 ? 'Implementing Changes' : `Retry Implementation ${claudeCount}`;
};

const appendPrLink = (
  item: HistoryItem, 
  stateUpper: string | undefined, 
  displayLabel: string | React.ReactNode
): React.ReactNode => {
  const itemPrInfo = item.metadata?.pr || item.metadata?.pullRequest;
  if ((stateUpper === 'COMPLETED' || stateUpper === 'POST_PROCESSING') && itemPrInfo?.url) {
    return (
      <>
        {displayLabel}
        <a
          href={itemPrInfo.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-700 underline ml-2"
        >
          (View PR #{itemPrInfo.number})
        </a>
      </>
    );
  }
  return displayLabel;
};

const TaskStatusTable: React.FC<TaskStatusTableProps> = ({ history }) => {
  return (
    <div className="p-4 bg-white rounded-lg border border-gray-200">
      <h4 className="text-lg font-semibold text-gray-900 mb-4">Task Implementation Status</h4>
      {history.length > 0 && (
        <div className="mt-0">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300">
                <th className="text-left py-2 pr-4 text-gray-700 font-semibold">#</th>
                <th className="text-left py-2 pr-4 text-gray-700 font-semibold">State</th>
                <th className="text-left py-2 pr-4 text-gray-700 font-semibold">Timestamp</th>
                <th className="text-right py-2 text-gray-700 font-semibold">Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.map((item, index) => {
                const duration = index < history.length - 1
                  ? new Date(history[index + 1].timestamp!).getTime() - new Date(item.timestamp!).getTime()
                  : null;
                
                const displayLabel = getDisplayLabel(item, index, history);
                const isLastItem = index === history.length - 1;
                const isRunning = isLastItem && duration === null && !['COMPLETED', 'FAILED'].includes(item.state?.toUpperCase() || '');
                
                return (
                  <tr key={index} className="border-b border-gray-200">
                    <td className="py-2 pr-4 text-gray-500">{index + 1}</td>
                    <td className={`py-2 pr-4 text-gray-800 ${isLastItem ? 'font-bold' : 'font-medium'}`}>{displayLabel}</td>
                    <td className="py-2 pr-4 text-gray-600 text-xs">{formatDate(item.timestamp!)}</td>
                    <td className="py-2 text-gray-600 text-xs text-right">
                      {isRunning ? (
                        <span className="inline-flex items-center gap-1">
                          <svg className="animate-spin h-3 w-3 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        </span>
                      ) : duration !== null ? formatRelativeTime(duration) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default TaskStatusTable;
