import React, { useState } from 'react';
import { LiveEvent, TaskInfo } from './types';
import { formatDisplayPath, stripWorkspacePrefixes } from './utils';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { github } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import diff from 'react-syntax-highlighter/dist/esm/languages/hljs/diff';
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import { FileText, Terminal, FileCode, File, ChevronDown, ChevronRight, CheckCircle, XCircle, Brain, Wrench } from 'lucide-react';

SyntaxHighlighter.registerLanguage('diff', diff);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('json', json);

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

const isNoisyTool = (toolName?: string) => {
  return ['read_file', 'glob', 'list_directory', 'search_file_content'].includes(toolName || '');
};

const getFileIcon = (filePath: string) => {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js')) return <FileCode size={14} className="text-blue-500" />;
    if (filePath.endsWith('.json')) return <FileCode size={14} className="text-yellow-500" />;
    if (filePath.endsWith('.sh')) return <Terminal size={14} className="text-gray-500" />;
    return <File size={14} className="text-gray-400" />;
};

const ThoughtEvent: React.FC<{ content?: string }> = ({ content }) => (
  <div className="text-gray-700 italic whitespace-pre-wrap">{content}</div>
);

const ToolUseEvent: React.FC<{ 
  event: LiveEvent; 
  taskInfo: TaskInfo | null; 
  isExpanded: boolean; 
  setIsExpanded: (val: boolean) => void 
}> = ({ event, taskInfo, isExpanded, setIsExpanded }) => (
  <div className="text-sm">
    <div 
        className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-1 rounded -ml-1"
        onClick={() => setIsExpanded(!isExpanded)}
    >
        {isExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        <p className="font-semibold text-gray-800 flex items-center gap-2">
        Tool: <span className="font-mono bg-gray-100 px-2 py-0.5 rounded border border-gray-300 text-xs">{event.toolName}</span>
        </p>
    </div>

    {isExpanded && (
        <div className="mt-2 pl-4 border-l-2 border-gray-100 space-y-2">
            {event.input?.file_path && (
            <p className="text-gray-600 flex items-center gap-2">
                {getFileIcon(event.input.file_path)}
                File: {renderClickablePath(event.input.file_path, taskInfo)}
            </p>
            )}
            {event.input?.command && (
            <p className="text-gray-600">
                Command: <code className="bg-gray-100 p-1 rounded font-mono text-xs border border-gray-300">{event.input.command}</code>
            </p>
            )}
            {/* Show other input params if needed, or JSON dump */}
            {!event.input?.file_path && !event.input?.command && event.input && (
                <pre className="text-xs text-gray-500 bg-gray-50 p-2 rounded border border-gray-100 overflow-x-auto">
                    {JSON.stringify(event.input, null, 2)}
                </pre>
            )}
        </div>
    )}
  </div>
);

const ToolResultEvent: React.FC<{
  event: LiveEvent;
  isExpanded: boolean;
  setIsExpanded: (val: boolean) => void;
}> = ({ event, isExpanded, setIsExpanded }) => {
  const formattedResult = formatToolResult(event.result);
  const isDiff = formattedResult.includes('\n') && (formattedResult.includes('\n+ ') || formattedResult.includes('\n- '));
  const language = isDiff ? 'diff' : 'typescript';

  return (
    <div className={`text-sm rounded ${event.isError ? 'bg-red-50 border border-red-100' : 'bg-white border border-gray-200'}`}>
       <div 
          className={`p-2 cursor-pointer flex justify-between items-center ${event.isError ? 'text-red-700' : 'text-gray-700'}`}
          onClick={() => setIsExpanded(!isExpanded)}
       >
          <div className="flex items-center gap-2">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className={`font-semibold ${event.isError ? 'text-red-600' : 'text-green-600'}`}>
              Tool Result {event.isError ? '(Error)' : '(Success)'}
              </span>
          </div>
       </div>
      
      {isExpanded && (
          <div className="px-2 pb-2">
              <SyntaxHighlighter 
                  language={language} 
                  style={github}
                  customStyle={{ fontSize: '12px', background: 'transparent', padding: '0.5rem' }}
                  wrapLongLines={true}
              >
                  {formattedResult}
              </SyntaxHighlighter>
          </div>
      )}
    </div>
  );
};

interface EventItemProps {
  event: LiveEvent;
  taskInfo: TaskInfo | null;
}

const EventItem: React.FC<EventItemProps> = ({ event, taskInfo }) => {
  const [isExpanded, setIsExpanded] = useState(!isNoisyTool(event.toolName));

  const getIcon = () => {
    if (event.type === 'thought') return <Brain className="text-purple-500" size={18} />;
    if (event.type === 'tool_use') return <Wrench className="text-blue-500" size={18} />;
    if (event.type === 'tool_result') return event.isError ? <XCircle className="text-red-500" size={18} /> : <CheckCircle className="text-green-500" size={18} />;
    return <FileText className="text-gray-500" size={18} />;
  };

  return (
    <div className="flex items-start gap-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center border border-gray-200">
        {getIcon()}
      </div>
      <div className="flex-1 pt-1 min-w-0">
        {event.type === 'thought' && (
          <ThoughtEvent content={event.content} />
        )}
        {event.type === 'tool_use' && (
          <ToolUseEvent 
            event={event} 
            taskInfo={taskInfo} 
            isExpanded={isExpanded} 
            setIsExpanded={setIsExpanded} 
          />
        )}
        {event.type === 'tool_result' && (
          <ToolResultEvent 
            event={event} 
            isExpanded={isExpanded} 
            setIsExpanded={setIsExpanded} 
          />
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
          {collapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
          <span>{isTaskActive ? 'Full Execution Event Log' : 'Execution Event Log'}</span>
          <span className="text-sm font-normal text-gray-500">({events.length} events)</span>
        </h4>
        {collapsed && lastThought && (
          <div className="text-sm text-gray-600 italic hidden md:block">
            Thinking: {lastThought.substring(0, 60)}{lastThought.length > 60 ? '...' : ''}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="mt-4 space-y-4 p-4 bg-white border border-gray-200 rounded-lg overflow-y-auto max-h-[800px]">
          {events.map((event, index) => (
            <EventItem key={index} event={event} taskInfo={taskInfo} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ExecutionEventLog;