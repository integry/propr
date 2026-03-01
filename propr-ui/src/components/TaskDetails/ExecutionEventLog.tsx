import React, { useState, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { LiveEvent, TaskInfo } from './types';
import { formatDisplayPath, stripWorkspacePrefixes } from './utils';
import MarkdownRenderer from './MarkdownRenderer';
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
  Lightbulb,
  Globe
} from 'lucide-react';

interface ExecutionEventLogProps {
  events: LiveEvent[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  lastThought: string | null;
  isTaskActive: boolean;
  taskInfo: TaskInfo | null;
  activeFilters?: Set<string>;
}

// Event categories for filtering
export type EventCategory = 'thought' | 'tool_use' | 'tool_result' | 'read' | 'write' | 'bash' | 'search';

// Get category for an event
export const getEventCategory = (event: LiveEvent): EventCategory => {
  if (event.type === 'thought') return 'thought';
  if (event.type === 'tool_result') return 'tool_result';

  const toolName = event.toolName?.toLowerCase() || '';
  if (toolName === 'read') return 'read';
  if (toolName === 'write' || toolName === 'edit') return 'write';
  if (toolName === 'bash') return 'bash';
  if (toolName === 'glob' || toolName === 'grep') return 'search';

  return 'tool_use';
};

// Get file icon based on file extension
const getFileIcon = (filePath: string) => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return <FileCode className="h-3.5 w-3.5 text-blue-500" />;
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return <FileJson className="h-3.5 w-3.5 text-yellow-500" />;
  }
  if (['md', 'txt', 'env'].includes(ext)) {
    return <FileText className="h-3.5 w-3.5 text-gray-500" />;
  }
  return <File className="h-3.5 w-3.5 text-gray-400" />;
};

// Get tool icon based on tool name
const getToolIcon = (toolName: string) => {
  const name = toolName.toLowerCase();

  if (name === 'read') return <Eye className="h-3.5 w-3.5" />;
  if (name === 'edit') return <Edit3 className="h-3.5 w-3.5" />;
  if (name === 'write') return <FileText className="h-3.5 w-3.5" />;
  if (name === 'glob' || name === 'grep') return <FolderSearch className="h-3.5 w-3.5" />;
  if (name === 'bash') return <Terminal className="h-3.5 w-3.5" />;
  if (name === 'webfetch' || name === 'websearch') return <Globe className="h-3.5 w-3.5" />;

  return <Wrench className="h-3.5 w-3.5" />;
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
      <span className="font-mono text-xs flex items-center gap-1">
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
      <span className="font-mono text-xs flex items-center gap-1">
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
      className="font-mono text-xs text-blue-600 hover:text-blue-700 underline flex items-center gap-1"
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
  maxHeight = '200px'
}) => {
  // For diff content, use special styling
  if (language === 'diff') {
    return (
      <SyntaxHighlighter
        language="diff"
        style={vscDarkPlus}
        customStyle={{
          fontSize: '11px',
          borderRadius: '0.25rem',
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
        fontSize: '11px',
        borderRadius: '0.25rem',
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

// Get category label and color for terminal-style display
const getCategoryDisplay = (event: LiveEvent): { label: string; color: string } => {
  if (event.type === 'thought') {
    return { label: 'THOUGHT', color: 'text-blue-600' };
  }
  if (event.type === 'tool_result') {
    return event.isError
      ? { label: 'ERROR', color: 'text-red-600' }
      : { label: 'RESULT', color: 'text-green-600' };
  }

  const toolName = event.toolName?.toUpperCase() || 'TOOL';
  return { label: toolName, color: 'text-gray-600' };
};

const getEventIcon = (event: LiveEvent): React.ReactNode => {
  if (event.type === 'thought') return <Lightbulb className="h-3.5 w-3.5 text-blue-600" />;
  if (event.type === 'tool_use') return getToolIcon(event.toolName || '');
  if (event.type === 'tool_result') {
    return event.isError ? <XCircle className="h-3.5 w-3.5 text-red-500" /> : <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
  }
  return <FileText className="h-3.5 w-3.5 text-gray-400" />;
};

// Extract summary from event content
const extractEventSummary = (event: LiveEvent): string => {
  if (event.type === 'thought' && event.content) {
    const firstLine = event.content.split('\n')[0];
    return firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine;
  }

  if (event.type === 'tool_use') {
    if (event.input?.file_path) {
      return formatDisplayPath(event.input.file_path);
    }
    if (event.input?.command) {
      const cmd = event.input.command;
      return cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd;
    }
    return event.toolName || '';
  }

  if (event.type === 'tool_result') {
    const resultStr = formatToolResult(event.result);
    const truncated = resultStr.slice(0, 50).replace(/\n/g, ' ');
    return truncated + (resultStr.length > 50 ? '...' : '');
  }

  return '';
};

interface TerminalEventItemProps {
  event: LiveEvent;
  taskInfo: TaskInfo | null;
  previousEvent?: LiveEvent;
  defaultCollapsed?: boolean;
  eventIndex: number;
}

const TerminalEventItem: React.FC<TerminalEventItemProps> = ({
  event,
  taskInfo,
  previousEvent,
  defaultCollapsed = false,
  eventIndex
}) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const filePath = previousEvent?.type === 'tool_use' ? previousEvent?.input?.file_path : undefined;
  const resultText = event.type === 'tool_result' ? formatToolResult(event.result) : '';
  const language = event.type === 'tool_result' ? detectLanguage(filePath, resultText) : 'text';

  const categoryDisplay = getCategoryDisplay(event);
  const summary = extractEventSummary(event);
  const hasExpandableContent =
    (event.type === 'thought' && event.content && event.content.length > 60) ||
    (event.type === 'tool_result' && resultText.length > 0) ||
    (event.type === 'tool_use' && (event.input?.command || event.input?.file_path));

  return (
    <div className="py-1">
      {/* Single-line header: [Icon] [CATEGORY] [Index] [Summary] */}
      <div className="flex items-start gap-2">
        {/* Icon in gutter */}
        <div className="flex-shrink-0 w-4 pt-0.5">
          {getEventIcon(event)}
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {/* Header line */}
          <div
            className={`flex items-center gap-2 flex-wrap ${hasExpandableContent ? 'cursor-pointer' : ''}`}
            onClick={hasExpandableContent ? () => setIsCollapsed(!isCollapsed) : undefined}
          >
            {/* Category label - utility header style */}
            <span className={`text-[10px] font-bold uppercase ${categoryDisplay.color}`}>
              {categoryDisplay.label}
            </span>

            {/* Event index - monospace */}
            <span className="font-mono text-[10px] text-gray-400">
              #{eventIndex + 1}
            </span>

            {/* Summary */}
            <span className="text-xs text-gray-600 truncate flex-1">
              {summary}
            </span>

            {/* Expand/collapse indicator */}
            {hasExpandableContent && (
              <span className="text-gray-400">
                {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </span>
            )}
          </div>

          {/* Expanded content */}
          {!isCollapsed && hasExpandableContent && (
            <div className="mt-1.5 ml-0">
              {/* Thought content */}
              {event.type === 'thought' && event.content && (
                <div className="text-xs text-gray-600 border-l-2 border-gray-100 pl-2">
                  <MarkdownRenderer text={event.content} />
                </div>
              )}

              {/* Tool use details */}
              {event.type === 'tool_use' && (
                <div className="text-xs space-y-1">
                  {event.input?.file_path && (
                    <div className="flex items-center gap-1 text-gray-500">
                      <span className="text-[10px] uppercase">File:</span>
                      {renderClickablePath(event.input.file_path, taskInfo)}
                    </div>
                  )}
                  {event.input?.command && (
                    <div>
                      <span className="text-[10px] text-gray-500 uppercase">Command:</span>
                      <code className="block bg-gray-900 text-gray-100 p-1.5 rounded font-mono text-[11px] mt-0.5 overflow-x-auto">
                        {event.input.command}
                      </code>
                    </div>
                  )}
                </div>
              )}

              {/* Tool result */}
              {event.type === 'tool_result' && resultText && (
                <div className="mt-1">
                  <SyntaxHighlightedResult result={resultText} language={language} maxHeight="200px" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ExecutionEventLog: React.FC<ExecutionEventLogProps> = ({
  events,
  collapsed,
  onToggleCollapse,
  lastThought,
  isTaskActive: _isTaskActive,
  taskInfo,
  activeFilters
}) => {
  // Note: isTaskActive is still passed for potential future use (e.g., showing live indicators)
  void _isTaskActive;

  // Filter events if filters are active
  const filteredEvents = useMemo(() => {
    if (!activeFilters || activeFilters.size === 0) return events;
    return events.filter(event => {
      const category = getEventCategory(event);
      return activeFilters.has(category);
    });
  }, [events, activeFilters]);

  // Get the last significant message (terminal output or tool result)
  const summaryMessage = useMemo(() => {
    if (filteredEvents.length === 0) return '';

    // Look backwards for the most relevant event
    for (let i = filteredEvents.length - 1; i >= 0; i--) {
      const event = filteredEvents[i];
      if (event.type === 'tool_result') {
        const resultStr = formatToolResult(event.result);
        const truncated = resultStr.slice(0, 60).replace(/\n/g, ' ');
        return `Result: ${truncated}${resultStr.length > 60 ? '...' : ''}`;
      }
      if (event.type === 'tool_use' && event.toolName) {
        if (event.input?.command) {
          return `> ${event.input.command.slice(0, 50)}${event.input.command.length > 50 ? '...' : ''}`;
        }
        return `Exec: ${event.toolName}`;
      }
    }

    return lastThought ? `Thinking: ${lastThought.substring(0, 60)}${lastThought.length > 60 ? '...' : ''}` : '';
  }, [filteredEvents, lastThought]);

  // Memoize default collapse states based on tool type
  const eventsWithDefaults = useMemo(() => {
    return filteredEvents.map((event, index) => {
      // Find the previous tool_use event for context
      let prevToolUse: LiveEvent | undefined;
      for (let i = index - 1; i >= 0; i--) {
        if (filteredEvents[i].type === 'tool_use') {
          prevToolUse = filteredEvents[i];
          break;
        }
      }

      // Determine if this result should be collapsed by default
      const shouldCollapse = event.type === 'tool_result' && prevToolUse?.toolName
        ? isNoisyTool(prevToolUse.toolName)
        : event.type !== 'thought'; // Collapse tool uses and results by default

      return {
        event,
        prevToolUse,
        defaultCollapsed: shouldCollapse,
        originalIndex: events.indexOf(event)
      };
    });
  }, [filteredEvents, events]);

  if (events.length === 0) {
    return null;
  }

  return (
    <div id="execution-event-log-section">
      {/* Collapsible header - terminal style */}
      <div
        className="flex items-center justify-between cursor-pointer py-1.5 -mx-1 px-1 rounded transition-colors hover:bg-gray-50"
        onClick={onToggleCollapse}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-400">
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </span>
          <Terminal className="h-3.5 w-3.5 text-gray-500" />
          <span className="text-[10px] font-bold uppercase text-gray-600">Execution Log</span>
          <span className="font-mono text-[10px] text-gray-400">
            ({filteredEvents.length}{activeFilters && activeFilters.size > 0 ? `/${events.length}` : ''})
          </span>
        </div>
        {collapsed && summaryMessage && (
          <div className="text-[10px] text-gray-500 truncate max-w-[200px] font-mono">
            {summaryMessage}
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="mt-1 divide-y divide-gray-50">
          {eventsWithDefaults.map(({ event, prevToolUse, defaultCollapsed, originalIndex }) => (
            <TerminalEventItem
              key={originalIndex}
              event={event}
              taskInfo={taskInfo}
              previousEvent={prevToolUse}
              defaultCollapsed={defaultCollapsed}
              eventIndex={originalIndex}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ExecutionEventLog;
