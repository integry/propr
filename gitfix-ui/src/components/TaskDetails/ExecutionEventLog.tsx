import React, { useState, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { LiveEvent, TaskInfo } from './types';
import { formatDisplayPath, stripWorkspacePrefixes } from './utils';
import {
  FileText,
  FileCode,
  FileJson,
  File,
  FolderSearch,
  Terminal,
  Edit3,
  Eye,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Wrench,
  Brain,
  Globe
} from 'lucide-react';

interface ExecutionEventLogProps {
  events: LiveEvent[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  lastThought: string | null;
  isTaskActive: boolean;
  taskInfo: TaskInfo | null;
}

// Get file icon based on file extension
const getFileIcon = (filePath: string) => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return <FileCode className="h-4 w-4 text-blue-500" />;
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return <FileJson className="h-4 w-4 text-yellow-500" />;
  }
  if (['md', 'txt', 'env'].includes(ext)) {
    return <FileText className="h-4 w-4 text-gray-500" />;
  }
  return <File className="h-4 w-4 text-gray-400" />;
};

// Get tool icon based on tool name
const getToolIcon = (toolName: string) => {
  const name = toolName.toLowerCase();

  if (name === 'read') return <Eye className="h-4 w-4" />;
  if (name === 'edit') return <Edit3 className="h-4 w-4" />;
  if (name === 'write') return <FileText className="h-4 w-4" />;
  if (name === 'glob' || name === 'grep') return <FolderSearch className="h-4 w-4" />;
  if (name === 'bash') return <Terminal className="h-4 w-4" />;
  if (name === 'webfetch' || name === 'websearch') return <Globe className="h-4 w-4" />;

  return <Wrench className="h-4 w-4" />;
};

// Detect if content is a diff
const isDiffContent = (content: string): boolean => {
  if (!content) return false;
  const lines = content.split('\n').slice(0, 10);
  const diffPatterns = [
    /^[+-]{3}\s/,        // --- or +++ at start
    /^@@\s.*@@/,         // @@ line numbers @@
    /^[+-]\s/,           // + or - at start of line
    /^diff --git/,       // git diff header
  ];

  return lines.some(line =>
    diffPatterns.some(pattern => pattern.test(line))
  );
};

// Detect language from file path or content
const detectLanguage = (filePath?: string, content?: string): string => {
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'tsx',
      'js': 'javascript',
      'jsx': 'jsx',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'py': 'python',
      'sh': 'bash',
      'bash': 'bash',
      'css': 'css',
      'scss': 'scss',
      'html': 'html',
      'xml': 'xml',
      'sql': 'sql',
      'go': 'go',
      'rs': 'rust',
      'java': 'java',
      'rb': 'ruby',
      'php': 'php',
    };
    if (langMap[ext]) return langMap[ext];
  }

  // Check content for diff patterns
  if (content && isDiffContent(content)) {
    return 'diff';
  }

  return 'text';
};

// Check if tool is typically noisy (should be collapsed by default)
const isNoisyTool = (toolName: string): boolean => {
  const name = toolName.toLowerCase();
  return ['read', 'glob', 'grep', 'todowrite'].includes(name);
};

const renderClickablePath = (fullPath: string, taskInfo: TaskInfo | null): React.ReactNode => {
  const cleanPath = formatDisplayPath(fullPath);

  if (!cleanPath || !cleanPath.includes('/') || cleanPath.startsWith('http')) {
    return (
      <span className="font-mono flex items-center gap-1">
        {getFileIcon(cleanPath)}
        {cleanPath}
      </span>
    );
  }

  const REPO_BASE_URL = taskInfo?.repoOwner && taskInfo?.repoName
    ? `https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/blob/main`
    : null;

  if (!REPO_BASE_URL) {
    return (
      <span className="font-mono flex items-center gap-1">
        {getFileIcon(cleanPath)}
        {cleanPath}
      </span>
    );
  }

  return (
    <a
      href={`${REPO_BASE_URL}/${cleanPath}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-blue-600 hover:text-blue-700 underline flex items-center gap-1"
    >
      {getFileIcon(cleanPath)}
      {cleanPath}
    </a>
  );
};

interface SyntaxHighlightedResultProps {
  result: string;
  language: string;
  maxHeight?: string;
}

const SyntaxHighlightedResult: React.FC<SyntaxHighlightedResultProps> = ({
  result,
  language,
  maxHeight = '300px'
}) => {
  // For diff content, use special styling
  if (language === 'diff') {
    return (
      <SyntaxHighlighter
        language="diff"
        style={vscDarkPlus}
        customStyle={{
          fontSize: '12px',
          borderRadius: '0.375rem',
          margin: 0,
          maxHeight,
          overflow: 'auto'
        }}
        showLineNumbers={false}
      >
        {result}
      </SyntaxHighlighter>
    );
  }

  return (
    <SyntaxHighlighter
      language={language}
      style={vscDarkPlus}
      customStyle={{
        fontSize: '12px',
        borderRadius: '0.375rem',
        margin: 0,
        maxHeight,
        overflow: 'auto'
      }}
      showLineNumbers={true}
      wrapLines={true}
    >
      {result}
    </SyntaxHighlighter>
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

// Sub-components for EventItem to reduce complexity
const ThoughtContent: React.FC<{ content?: string }> = ({ content }) => (
  <div className="text-gray-700 italic whitespace-pre-wrap text-sm">{content}</div>
);

const ToolUseContent: React.FC<{ event: LiveEvent; taskInfo: TaskInfo | null }> = ({ event, taskInfo }) => (
  <div className="text-sm">
    <div className="flex items-center gap-2 mb-1">
      <span className="font-semibold text-gray-800 bg-gray-100 px-2 py-0.5 rounded border border-gray-200 text-xs">
        {event.toolName}
      </span>
    </div>
    {event.input?.file_path && (
      <p className="text-gray-600 mt-1 flex items-center gap-1">
        <span className="text-gray-500">File:</span>
        {renderClickablePath(event.input.file_path, taskInfo)}
      </p>
    )}
    {event.input?.command && (
      <div className="mt-1">
        <span className="text-gray-500 text-xs">Command:</span>
        <code className="block bg-gray-900 text-gray-100 p-2 rounded font-mono text-xs mt-1 overflow-x-auto">
          {event.input.command}
        </code>
      </div>
    )}
  </div>
);

interface ToolResultContentProps {
  event: LiveEvent;
  resultText: string;
  language: string;
  isCollapsed: boolean;
  onToggle: () => void;
}

const ToolResultContent: React.FC<ToolResultContentProps> = ({
  event,
  resultText,
  language,
  isCollapsed,
  onToggle
}) => {
  const sizeDisplay = resultText.length > 1000
    ? `${Math.round(resultText.length / 1024)}KB`
    : `${resultText.length} chars`;

  return (
    <div className={`text-sm rounded-lg overflow-hidden ${event.isError ? 'border border-red-200' : 'border border-gray-200'}`}>
      <div
        className={`flex items-center justify-between px-3 py-2 cursor-pointer ${event.isError ? 'bg-red-50' : 'bg-gray-50'}`}
        onClick={onToggle}
      >
        <span className={`font-semibold text-xs ${event.isError ? 'text-red-600' : 'text-green-600'}`}>
          Tool Result {event.isError ? '(Error)' : '(Success)'}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">{sizeDisplay}</span>
          {isCollapsed ? <ChevronRight className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
        </div>
      </div>
      {!isCollapsed && (
        <div className="p-2">
          <SyntaxHighlightedResult result={resultText} language={language} maxHeight="300px" />
        </div>
      )}
    </div>
  );
};

const getEventIcon = (event: LiveEvent): React.ReactNode => {
  if (event.type === 'thought') return <Brain className="h-4 w-4 text-purple-500" />;
  if (event.type === 'tool_use') return getToolIcon(event.toolName || '');
  if (event.type === 'tool_result') {
    return event.isError ? <XCircle className="h-4 w-4 text-red-500" /> : <CheckCircle2 className="h-4 w-4 text-green-500" />;
  }
  return <FileText className="h-4 w-4 text-gray-400" />;
};

interface EventItemProps {
  event: LiveEvent;
  taskInfo: TaskInfo | null;
  previousEvent?: LiveEvent;
  defaultCollapsed?: boolean;
}

const EventItem: React.FC<EventItemProps> = ({ event, taskInfo, previousEvent, defaultCollapsed = false }) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const filePath = previousEvent?.type === 'tool_use' ? previousEvent?.input?.file_path : undefined;
  const resultText = event.type === 'tool_result' ? formatToolResult(event.result) : '';
  const language = event.type === 'tool_result' ? detectLanguage(filePath, resultText) : 'text';

  return (
    <div className="flex items-start gap-3">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
        {getEventIcon(event)}
      </div>
      <div className="flex-1 min-w-0">
        {event.type === 'thought' && <ThoughtContent content={event.content} />}
        {event.type === 'tool_use' && <ToolUseContent event={event} taskInfo={taskInfo} />}
        {event.type === 'tool_result' && (
          <ToolResultContent
            event={event}
            resultText={resultText}
            language={language}
            isCollapsed={isCollapsed}
            onToggle={() => setIsCollapsed(!isCollapsed)}
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
  // Memoize default collapse states based on tool type
  const eventsWithDefaults = useMemo(() => {
    return events.map((event, index) => {
      // Find the previous tool_use event for context
      let prevToolUse: LiveEvent | undefined;
      for (let i = index - 1; i >= 0; i--) {
        if (events[i].type === 'tool_use') {
          prevToolUse = events[i];
          break;
        }
      }

      // Determine if this result should be collapsed by default
      const shouldCollapse = event.type === 'tool_result' && prevToolUse?.toolName
        ? isNoisyTool(prevToolUse.toolName)
        : false;

      return {
        event,
        prevToolUse,
        defaultCollapsed: shouldCollapse
      };
    });
  }, [events]);

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
          <span className="text-gray-500">{collapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}</span>
          <Terminal className="h-5 w-5 text-gray-600" />
          <span>{isTaskActive ? 'Full Execution Event Log' : 'Execution Event Log'}</span>
          <span className="text-sm font-normal text-gray-500">({events.length} events)</span>
        </h4>
        {collapsed && lastThought && (
          <div className="text-sm text-gray-600 italic max-w-md truncate">
            Thinking: {lastThought.substring(0, 100)}{lastThought.length > 100 ? '...' : ''}
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="mt-4 space-y-4 p-4 bg-white border border-gray-200 rounded-lg max-h-[800px] overflow-y-auto">
          {eventsWithDefaults.map(({ event, prevToolUse, defaultCollapsed }, index) => (
            <EventItem
              key={index}
              event={event}
              taskInfo={taskInfo}
              previousEvent={prevToolUse}
              defaultCollapsed={defaultCollapsed}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ExecutionEventLog;
