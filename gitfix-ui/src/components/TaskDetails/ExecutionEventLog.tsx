import React from 'react';
import { LiveEvent, TaskInfo } from './types';
import { formatDisplayPath, stripWorkspacePrefixes } from './utils';

interface ExecutionEventLogProps {
  events: LiveEvent[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  lastThought: string | null;
  isTaskActive: boolean;
  taskInfo: TaskInfo | null;
}

const renderClickablePath = (fullPath: string, taskInfo: TaskInfo | null): React.ReactNode => {
  const cleanPath = formatDisplayPath(fullPath);
  
  if (!cleanPath || !cleanPath.includes('/') || cleanPath.startsWith('http')) {
    return <span className="font-mono">{cleanPath}</span>;
  }

  const REPO_BASE_URL = taskInfo?.repoOwner && taskInfo?.repoName
    ? `https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/blob/main`
    : null;

  if (!REPO_BASE_URL) {
    return <span className="font-mono">{cleanPath}</span>;
  }

  return (
    <a
      href={`${REPO_BASE_URL}/${cleanPath}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-blue-600 hover:text-blue-700 underline"
    >
      {cleanPath}
    </a>
  );
};

const formatToolResult = (result: string | object | undefined): string => {
  let resultText: string;
  if (typeof result === 'string') {
    resultText = result;
  } else if (result === undefined) {
    resultText = '(undefined)';
  } else if (result === null) {
    resultText = '(null)';
  } else {
    try {
      resultText = JSON.stringify(result, null, 2);
    } catch {
      resultText = String(result);
    }
  }
  return stripWorkspacePrefixes(resultText);
};

interface EventItemProps {
  event: LiveEvent;
  taskInfo: TaskInfo | null;
}

const EventItem: React.FC<EventItemProps> = ({ event, taskInfo }) => {
  const getIcon = () => {
    if (event.type === 'thought') return '🧠';
    if (event.type === 'tool_use') return '🛠️';
    if (event.type === 'tool_result') return event.isError ? '❌' : '✅';
    return '📝';
  };

  return (
    <div className="flex items-start gap-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-lg">
        {getIcon()}
      </div>
      <div className="flex-1 pt-1">
        {event.type === 'thought' && (
          <div className="text-gray-700 italic whitespace-pre-wrap">{event.content}</div>
        )}
        {event.type === 'tool_use' && (
          <div className="text-sm">
            <p className="font-semibold text-gray-800">
              Tool: <span className="font-mono bg-gray-100 px-2 py-1 rounded border border-gray-300">{event.toolName}</span>
            </p>
            {event.input?.file_path && (
              <p className="text-gray-600 mt-1">
                File: {renderClickablePath(event.input.file_path, taskInfo)}
              </p>
            )}
            {event.input?.command && (
              <p className="text-gray-600 mt-1">
                Command: <code className="bg-gray-100 p-1 rounded font-mono text-xs border border-gray-300">{event.input.command}</code>
              </p>
            )}
          </div>
        )}
        {event.type === 'tool_result' && (
          <div className={`text-sm p-2 rounded ${event.isError ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'}`}>
            <p className={`font-semibold ${event.isError ? 'text-red-600' : 'text-green-600'}`}>
              Tool Result {event.isError ? '(Error)' : '(Success)'}
            </p>
            <pre className="whitespace-pre-wrap font-mono text-xs text-gray-600 mt-1 max-h-40 overflow-y-auto">
              {formatToolResult(event.result)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

const ExecutionEventLog: React.FC<ExecutionEventLogProps> = ({
  events,
  collapsed,
  onToggleCollapse,
  lastThought,
  isTaskActive,
  taskInfo
}) => {
  if (events.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <div
        className="flex items-center justify-between cursor-pointer p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors border border-gray-200"
        onClick={onToggleCollapse}
      >
        <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-3">
          <span>{collapsed ? '▶' : '▼'}</span>
          <span>{isTaskActive ? 'Full Execution Event Log' : 'Execution Event Log'}</span>
          <span className="text-sm font-normal text-gray-500">({events.length} events)</span>
        </h4>
        {collapsed && lastThought && (
          <div className="text-sm text-gray-600 italic">
            Thinking: {lastThought.substring(0, 100)}{lastThought.length > 100 ? '...' : ''}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="mt-4 space-y-4 p-4 bg-white border border-gray-200 rounded-lg overflow-y-auto">
          {events.map((event, index) => (
            <EventItem key={index} event={event} taskInfo={taskInfo} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ExecutionEventLog;
