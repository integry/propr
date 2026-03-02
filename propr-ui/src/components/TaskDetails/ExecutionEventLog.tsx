import React, { useState, useMemo } from 'react';
import { LiveEvent, TaskInfo } from './types';
import { getEventCategory } from './utils';
import MarkdownRenderer from './MarkdownRenderer';
import {
  ChevronUp,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  detectLanguage,
  formatToolResult,
  getCategoryDisplay,
  extractEventSummary,
} from './ExecutionEventUtils';
import {
  EventIcon,
  ClickablePath,
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
        <ClickablePath fullPath={event.input.file_path} taskInfo={taskInfo} />
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

// Check if event has expandable content
const hasExpandableContent = (event: LiveEvent, resultText: string): boolean => {
  return (
    (event.type === 'thought' && !!event.content && event.content.length > 60) ||
    (event.type === 'tool_result' && resultText.length > 0) ||
    (event.type === 'tool_use' && !!(event.input?.command || event.input?.file_path))
  );
};

// Event header component
const EventHeader: React.FC<{
  categoryDisplay: { label: string; color: string };
  eventIndex: number;
  summary: string;
  expandable: boolean;
  isCollapsed: boolean;
  onToggle?: () => void;
}> = ({ categoryDisplay, eventIndex, summary, expandable, isCollapsed, onToggle }) => (
  <div
    className={`flex items-center gap-2 flex-wrap ${expandable ? 'cursor-pointer' : ''}`}
    onClick={onToggle}
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
    {expandable && (
      <span className="text-gray-400">
        {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </span>
    )}
  </div>
);

interface TerminalEventItemProps {
  event: LiveEvent;
  taskInfo: TaskInfo | null;
  previousEvent?: LiveEvent;
  eventIndex: number;
}

const TerminalEventItem: React.FC<TerminalEventItemProps> = ({
  event,
  taskInfo,
  previousEvent,
  eventIndex
}) => {
  // Always start expanded
  const [isCollapsed, setIsCollapsed] = useState(false);

  const filePath = previousEvent?.type === 'tool_use' ? previousEvent?.input?.file_path : undefined;
  const resultText = event.type === 'tool_result' ? formatToolResult(event.result) : '';
  const language = event.type === 'tool_result' ? detectLanguage(filePath, resultText) : 'text';

  const categoryDisplay = getCategoryDisplay(event);
  const summary = extractEventSummary(event);
  const expandable = hasExpandableContent(event, resultText);

  const handleToggle = expandable ? () => setIsCollapsed(!isCollapsed) : undefined;

  return (
    <div className="py-1">
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 w-4 pt-0.5">
          <EventIcon event={event} />
        </div>

        <div className="flex-1 min-w-0">
          <EventHeader
            categoryDisplay={categoryDisplay}
            eventIndex={eventIndex}
            summary={summary}
            expandable={expandable}
            isCollapsed={isCollapsed}
            onToggle={handleToggle}
          />

          {!isCollapsed && expandable && (
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

// Compute summary message for collapsed view
const computeSummaryMessage = (filteredEvents: LiveEvent[], lastThought: string | null): string => {
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
};

// Compute events with their previous tool_use reference for context
const computeEventsWithContext = (
  filteredEvents: LiveEvent[],
  allEvents: LiveEvent[]
): Array<{ event: LiveEvent; prevToolUse?: LiveEvent; originalIndex: number }> => {
  return filteredEvents.map((event, index) => {
    let prevToolUse: LiveEvent | undefined;
    for (let i = index - 1; i >= 0; i--) {
      if (filteredEvents[i].type === 'tool_use') {
        prevToolUse = filteredEvents[i];
        break;
      }
    }

    return {
      event,
      prevToolUse,
      originalIndex: allEvents.indexOf(event)
    };
  });
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

  const summaryMessage = useMemo(
    () => computeSummaryMessage(filteredEvents, lastThought),
    [filteredEvents, lastThought]
  );

  const eventsWithContext = useMemo(
    () => computeEventsWithContext(filteredEvents, events),
    [filteredEvents, events]
  );

  if (events.length === 0) {
    return null;
  }

  const eventCount = filteredEvents.length;
  const showFilteredCount = activeFilters && activeFilters.size > 0 && filteredEvents.length !== events.length;

  return (
    <div id="execution-event-log-section" className="flex-shrink-0 border-t border-gray-200 bg-white flex flex-col">
      {/* Expandable Content - only shown when not collapsed */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto max-h-[40vh] border-b border-gray-200">
          <div className="p-4 divide-y divide-gray-50">
            {eventsWithContext.map(({ event, prevToolUse, originalIndex }) => (
              <TerminalEventItem
                key={originalIndex}
                event={event}
                taskInfo={taskInfo}
                previousEvent={prevToolUse}
                eventIndex={originalIndex}
              />
            ))}
          </div>
        </div>
      )}

      {/* Anchored Footer Bar - consistent with Plan Studio and Task List */}
      <div
        className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-100 hover:bg-gray-200 transition-colors cursor-pointer flex-shrink-0"
        onClick={onToggleCollapse}
      >
        <div className="flex items-center gap-2.5">
          <span className="text-gray-500 font-mono text-sm">{'>_'}</span>
          <span className="font-mono text-xs font-bold text-gray-700 uppercase tracking-wider">
            EXECUTION LOG ({showFilteredCount ? `${eventCount}/${events.length}` : eventCount})
          </span>
        </div>
        <div className="flex items-center gap-3">
          {collapsed && summaryMessage && (
            <span className="text-xs text-gray-500 truncate max-w-[240px] font-mono">
              {summaryMessage}
            </span>
          )}
          <span className="text-gray-500">
            {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
        </div>
      </div>
    </div>
  );
};

export default ExecutionEventLog;
