import React, { useState, useMemo } from 'react';
import { LiveEvent, TaskInfo } from './types';
import { getEventCategory } from './utils';
import MarkdownRenderer from './MarkdownRenderer';
import {
  Terminal,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  detectLanguage,
  isNoisyTool,
  formatToolResult,
  getCategoryDisplay,
  getEventIcon,
  extractEventSummary,
  renderClickablePath,
  SyntaxHighlightedResult,
} from './ExecutionEventHelpers';

interface ExecutionEventLogProps {
  events: LiveEvent[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  lastThought: string | null;
  isTaskActive: boolean;
  taskInfo: TaskInfo | null;
  activeFilters?: Set<string>;
}

// Separate component for thought content rendering
const ThoughtContent: React.FC<{ content: string }> = ({ content }) => (
  <div className="text-xs text-gray-600 border-l-2 border-gray-100 pl-2">
    <MarkdownRenderer text={content} />
  </div>
);

// Separate component for tool use details rendering
const ToolUseDetails: React.FC<{ event: LiveEvent; taskInfo: TaskInfo | null }> = ({ event, taskInfo }) => (
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
);

// Separate component for tool result rendering
const ToolResultContent: React.FC<{ resultText: string; language: string }> = ({ resultText, language }) => (
  <div className="mt-1">
    <SyntaxHighlightedResult result={resultText} language={language} maxHeight="200px" />
  </div>
);

// Expanded content component to reduce complexity
const ExpandedContent: React.FC<{
  event: LiveEvent;
  taskInfo: TaskInfo | null;
  resultText: string;
  language: string;
}> = ({ event, taskInfo, resultText, language }) => {
  if (event.type === 'thought' && event.content) {
    return <ThoughtContent content={event.content} />;
  }

  if (event.type === 'tool_use') {
    return <ToolUseDetails event={event} taskInfo={taskInfo} />;
  }

  if (event.type === 'tool_result' && resultText) {
    return <ToolResultContent resultText={resultText} language={language} />;
  }

  return null;
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

  const handleToggle = hasExpandableContent ? () => setIsCollapsed(!isCollapsed) : undefined;

  return (
    <div className="py-1">
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 w-4 pt-0.5">
          {getEventIcon(event)}
        </div>

        <div className="flex-1 min-w-0">
          <div
            className={`flex items-center gap-2 flex-wrap ${hasExpandableContent ? 'cursor-pointer' : ''}`}
            onClick={handleToggle}
          >
            <span className={`text-[10px] font-bold uppercase ${categoryDisplay.color}`}>
              {categoryDisplay.label}
            </span>
            <span className="font-mono text-[10px] text-gray-400">
              #{eventIndex + 1}
            </span>
            <span className="text-xs text-gray-600 truncate flex-1">
              {summary}
            </span>
            {hasExpandableContent && (
              <span className="text-gray-400">
                {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </span>
            )}
          </div>

          {!isCollapsed && hasExpandableContent && (
            <div className="mt-1.5 ml-0">
              <ExpandedContent
                event={event}
                taskInfo={taskInfo}
                resultText={resultText}
                language={language}
              />
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
  // Note: isTaskActive is still passed for potential future use
  void _isTaskActive;

  const filteredEvents = useMemo(() => {
    if (!activeFilters || activeFilters.size === 0) return events;
    return events.filter(event => {
      const category = getEventCategory(event);
      return activeFilters.has(category);
    });
  }, [events, activeFilters]);

  const summaryMessage = useMemo(() => {
    if (filteredEvents.length === 0) return '';

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

  const eventsWithDefaults = useMemo(() => {
    return filteredEvents.map((event, index) => {
      let prevToolUse: LiveEvent | undefined;
      for (let i = index - 1; i >= 0; i--) {
        if (filteredEvents[i].type === 'tool_use') {
          prevToolUse = filteredEvents[i];
          break;
        }
      }

      const shouldCollapse = event.type === 'tool_result' && prevToolUse?.toolName
        ? isNoisyTool(prevToolUse.toolName)
        : event.type !== 'thought';

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
