import React, { useState, useMemo } from 'react';
import { LiveEvent, TaskInfo } from './types';
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
}

// Separate component for thought content rendering
const ThoughtContent: React.FC<{ content: string }> = ({ content }) => (
  <div className="text-xs text-zinc-200 pl-2 overflow-hidden font-mono">
    <MarkdownRenderer text={content} darkMode={true} />
  </div>
);

// Separate component for tool use details rendering
const ToolUseDetails: React.FC<{ event: LiveEvent; taskInfo: TaskInfo | null }> = ({ event, taskInfo }) => (
  <div className="text-xs space-y-1 font-mono">
    {event.input?.file_path && (
      <div className="flex items-center gap-1 text-zinc-300">
        <span className="text-[10px] uppercase text-zinc-400 font-bold tracking-widest">File:</span>
        <ClickablePath fullPath={event.input.file_path} taskInfo={taskInfo} />
      </div>
    )}
    {event.input?.command && (
      <div>
        <span className="text-[10px] text-zinc-400 uppercase font-bold tracking-widest">Command:</span>
        <code className="block border border-zinc-800 bg-transparent text-emerald-400/80 p-1.5 rounded font-mono text-[11px] mt-0.5 overflow-x-auto">
          {event.input.command}
        </code>
      </div>
    )}
  </div>
);

// Operator steering message - rendered verbatim with an amber accent so it never
// reads as provider output. Only the goal timeline produces these events.
const UserInputContent: React.FC<{ event: LiveEvent }> = ({ event }) => (
  <div className="border-l-2 border-amber-400/70 bg-amber-400/5 pl-2 py-1 text-xs text-amber-50/90 overflow-hidden font-mono whitespace-pre-wrap break-words">
    {event.content}
  </div>
);

// Queued / attachment metadata for an operator message
const UserInputBadges: React.FC<{ event: LiveEvent }> = ({ event }) => {
  if (event.type !== 'user_input') return null;
  return (
    <>
      {event.inputState === 'pending' && (
        <span className="rounded border border-amber-400/50 px-1 text-[10px] font-bold uppercase tracking-wider text-amber-300">
          Queued
        </span>
      )}
      {event.inputState === 'undeliverable' && (
        <span className="rounded border border-red-400/50 px-1 text-[10px] font-bold uppercase tracking-wider text-red-300">
          Not delivered
        </span>
      )}
      {!!event.attachmentCount && (
        <span className="text-[10px] text-amber-200/80">
          {event.attachmentCount} attachment{event.attachmentCount === 1 ? '' : 's'}
        </span>
      )}
    </>
  );
};

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
  if (event.type === 'user_input') {
    return <UserInputContent event={event} />;
  }

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
    (event.type === 'user_input' && !!event.content) ||
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
  badges?: React.ReactNode;
}> = ({ categoryDisplay, eventIndex, summary, expandable, isCollapsed, onToggle, badges }) => (
  <div
    className={`flex items-center gap-2 flex-wrap font-mono ${expandable ? 'cursor-pointer' : ''}`}
    onClick={onToggle}
  >
    <span className={`text-[10px] font-bold uppercase tracking-widest ${categoryDisplay.color}`}>
      {categoryDisplay.label}
    </span>
    <span className="text-[10px] text-zinc-400">
      #{eventIndex + 1}
    </span>
    <span className="text-[12px] text-zinc-200 truncate flex-1">
      {summary}
    </span>
    {badges}
    {expandable && (
      <span className="text-zinc-600">
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
    <div className="py-0.5">
      <div className="flex items-start gap-2">
        {/* Left gutter with icon and vertical threading line */}
        <div className="flex-shrink-0 w-4 flex flex-col items-center">
          <div className="pt-0.5">
            <EventIcon event={event} />
          </div>
          {/* Vertical threading line */}
          <div className="flex-1 w-px bg-zinc-800 mt-1" />
        </div>

        <div className="flex-1 min-w-0 overflow-hidden pb-1">
          <EventHeader
            categoryDisplay={categoryDisplay}
            eventIndex={eventIndex}
            summary={summary}
            expandable={expandable}
            isCollapsed={isCollapsed}
            onToggle={handleToggle}
            badges={<UserInputBadges event={event} />}
          />

          {!isCollapsed && expandable && (
            <div className="mt-1 ml-0 overflow-hidden">
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

// Compute summary message for collapsed view - always shows the last event
const computeSummaryMessage = (filteredEvents: LiveEvent[], lastThought: string | null): string => {
  if (filteredEvents.length === 0) {
    // Fallback to lastThought if no events
    return lastThought ? `Thinking: ${lastThought.substring(0, 150)}${lastThought.length > 150 ? '...' : ''}` : '';
  }

  // Always use the last event, regardless of type
  const event = filteredEvents[filteredEvents.length - 1];

  if (event.type === 'tool_result') {
    const resultStr = formatToolResult(event.result);
    const truncated = resultStr.slice(0, 150).replace(/\n/g, ' ');
    return `Result: ${truncated}${resultStr.length > 150 ? '...' : ''}`;
  }

  if (event.type === 'tool_use' && event.toolName) {
    if (event.input?.command) {
      return `> ${event.input.command.slice(0, 150)}${event.input.command.length > 150 ? '...' : ''}`;
    }
    if (event.input?.file_path) {
      return `${event.toolName}: ${event.input.file_path}`;
    }
    return `Exec: ${event.toolName}`;
  }

  if (event.type === 'thought' && event.content) {
    const truncated = event.content.slice(0, 150).replace(/\n/g, ' ');
    return `Thinking: ${truncated}${event.content.length > 150 ? '...' : ''}`;
  }

  return '';
};

// Compute events with their previous tool_use reference for context
const computeEventsWithContext = (
  events: LiveEvent[],
): Array<{ event: LiveEvent; prevToolUse?: LiveEvent; originalIndex: number }> => {
  let previousToolUse: LiveEvent | undefined;
  return events.map((event, originalIndex) => {
    const eventWithContext = { event, prevToolUse: previousToolUse, originalIndex };
    if (event.type === 'tool_use') previousToolUse = event;
    return eventWithContext;
  });
};

const ExecutionEventLog: React.FC<ExecutionEventLogProps> = ({
  events,
  collapsed,
  onToggleCollapse,
  lastThought,
  isTaskActive: _isTaskActive,
  taskInfo
}) => {
  // Note: isTaskActive is still passed for potential future use
  void _isTaskActive;

  const summaryMessage = useMemo(
    () => computeSummaryMessage(events, lastThought),
    [events, lastThought]
  );

  // The log starts collapsed, so do not materialize its potentially large
  // Markdown and syntax-highlighted history until the user opens it. Live
  // socket updates otherwise rebuild the entire hidden tree on every event and
  // can block unrelated response handling on the browser main thread.
  const eventsWithContext = useMemo(
    () => collapsed ? [] : computeEventsWithContext(events),
    [collapsed, events]
  );

  if (events.length === 0) {
    return null;
  }

  return (
    <div id="execution-event-log-section" className={`border-t border-slate-200 flex flex-col-reverse transition-all duration-300 ease-in-out min-w-0 overflow-hidden ${collapsed ? 'flex-shrink-0 bg-white' : 'flex-1 min-h-0 bg-zinc-900'}`}>
      {/* VS Code Terminal Footer Bar - Solid full-width bar with zinc palette */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls="execution-event-log-content"
        className={`flex w-full items-center justify-between px-3 sm:px-6 h-9 text-left transition-all duration-300 cursor-pointer flex-shrink-0 ${
          collapsed
            ? 'bg-slate-100 hover:bg-slate-200 border-t border-slate-200 text-slate-500'
            : 'bg-zinc-900 text-white'
        }`}
        onClick={onToggleCollapse}
      >
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <span className={`font-mono text-sm font-bold ${collapsed ? 'text-slate-500' : 'text-zinc-400'}`}>{'>_'}</span>
          <span className={`font-mono text-[11px] font-bold uppercase tracking-wider ${collapsed ? 'text-slate-600' : 'text-white'}`}>
            {collapsed ? 'EXECUTION LOG' : 'TERMINAL OUTPUT'} ({events.length})
          </span>
        </div>
        <div className="flex items-center gap-3 justify-end min-w-0 flex-1 pl-4">
          {collapsed && summaryMessage && (
            <span className="text-[10px] text-slate-500 truncate text-right font-mono">
              {summaryMessage}
            </span>
          )}
          <span className={`flex-shrink-0 ${collapsed ? 'text-slate-500' : 'text-zinc-400'}`}>
            {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
        </div>
      </button>

      {/* Expandable Content - VS Code Integrated Terminal Style with zinc-950 background */}
      <div
        id="execution-event-log-content"
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          collapsed
            ? 'max-h-0 opacity-0'
            : 'max-h-[9999px] opacity-100 flex-1 min-h-0 bg-zinc-900 text-zinc-300'
        }`}
      >
        <div
          data-testid="execution-log-scroll"
          className={`overflow-y-auto overscroll-contain scrollbar-stealth-dark ${collapsed ? 'h-0' : 'h-full'}`}
        >
          {/* Continuous stream layout - no dividers between items */}
          <div className="p-3 space-y-0">
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
      </div>
    </div>
  );
};

export default ExecutionEventLog;
