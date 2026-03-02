import React, { useMemo } from 'react';
import { LiveEvent, TodoItem } from './types';
import { renderMarkdown } from './renderMarkdown';
import { detectThoughtType } from './utils';
import { Lightbulb, Wrench, Search, CheckCircle2 } from 'lucide-react';

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

interface ThinkingLogProps {
  events: ThinkingLogEvent[];
  todos?: TodoItem[];
  highlightedTodoId?: string | null;
  activeFilters?: Set<string>;
}

// Get category display info for terminal-style output
const getCategoryInfo = (type: 'analysis' | 'action' | 'summary' | 'search') => {
  switch (type) {
    case 'summary':
      return {
        label: 'SUMMARY',
        textColor: 'text-amber-600',
        Icon: CheckCircle2
      };
    case 'action':
      return {
        label: 'ACTION',
        textColor: 'text-green-600',
        Icon: Wrench
      };
    case 'search':
      return {
        label: 'SEARCH',
        textColor: 'text-purple-600',
        Icon: Search
      };
    case 'analysis':
    default:
      return {
        label: 'ANALYSIS',
        textColor: 'text-blue-600',
        Icon: Lightbulb
      };
  }
};

interface TerminalLogEntryProps {
  event: ThinkingLogEvent;
  todoContext?: string;
  isHighlighted?: boolean;
}

const TerminalLogEntry: React.FC<TerminalLogEntryProps> = ({ event, todoContext, isHighlighted }) => {
  const thoughtType = detectThoughtType(event.content || '');
  const categoryInfo = getCategoryInfo(thoughtType);
  const { Icon } = categoryInfo;

  return (
    <div
      className={`py-1.5 transition-all duration-200 ${
        isHighlighted ? 'bg-blue-50/50' : ''
      }`}
    >
      {/* Single-line header: [Icon] [CATEGORY] [Timestamp] [Summary] */}
      <div className="flex items-start gap-2">
        {/* Icon in the gutter */}
        <div className="flex-shrink-0 w-4 pt-0.5">
          <Icon className={`h-3.5 w-3.5 ${categoryInfo.textColor}`} />
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Header line */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Category label - utility header style */}
            <span className={`text-[10px] font-bold uppercase ${categoryInfo.textColor}`}>
              {categoryInfo.label}
            </span>

            {/* Timestamp - monospace */}
            {event.relativeTime && (
              <span className="font-mono text-[10px] text-gray-400">
                {event.relativeTime}
              </span>
            )}

            {/* Todo context if available */}
            {todoContext && (
              <span className="text-[10px] text-gray-400 truncate">
                → {todoContext}
              </span>
            )}
          </div>

          {/* Full content - shown directly */}
          {event.content && (
            <div className="text-sm text-gray-700 mt-0.5 leading-relaxed break-words overflow-hidden">
              {renderMarkdown(event.content)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface ThoughtGroupProps {
  title: string;
  events: ThinkingLogEvent[];
  isCompleted: boolean;
  todoId?: string;
  isHighlighted?: boolean;
  activeFilters?: Set<string>;
}

const ThoughtGroup: React.FC<ThoughtGroupProps> = ({ title, events, isCompleted, todoId, isHighlighted, activeFilters }) => {
  // Filter events if filters are active
  const filteredEvents = useMemo(() => {
    if (!activeFilters || activeFilters.size === 0) return events;
    return events.filter(event => {
      const type = detectThoughtType(event.content || '');
      return activeFilters.has(type);
    });
  }, [events, activeFilters]);

  if (filteredEvents.length === 0) return null;

  return (
    <div
      className={`transition-all duration-300 ${
        isHighlighted ? 'ring-1 ring-blue-300 ring-offset-1 rounded' : ''
      }`}
      id={todoId ? `thinking-log-${todoId}` : undefined}
      data-todo-id={todoId}
      data-todo-content={title}
    >
      {/* Group Header - terminal style */}
      <div className="flex items-center gap-2 py-1 border-b border-gray-100 mb-1">
        {isCompleted ? (
          <CheckCircle2 className="h-3 w-3 text-slate-400" />
        ) : (
          <div className="h-3 w-3 rounded-full border border-gray-300 bg-gray-50" />
        )}
        <span className={`text-xs font-medium ${isCompleted ? 'text-slate-600' : 'text-gray-600'}`}>
          {title}
        </span>
        <span className="text-[10px] text-gray-400">
          ({filteredEvents.length})
        </span>
      </div>

      {/* Log entries */}
      <div className="space-y-0 divide-y divide-gray-50">
        {filteredEvents.map((event, index) => (
          <TerminalLogEntry
            key={index}
            event={event}
            todoContext={undefined}
            isHighlighted={false}
          />
        ))}
      </div>
    </div>
  );
};

const ThinkingLog: React.FC<ThinkingLogProps> = ({ events, todos = [], highlightedTodoId, activeFilters }) => {
  // Filter events at the top level to get accurate count - must be before any early returns
  const filteredEventCount = useMemo(() => {
    if (!activeFilters || activeFilters.size === 0) return events.length;
    return events.filter(event => {
      const type = detectThoughtType(event.content || '');
      return activeFilters.has(type);
    }).length;
  }, [events, activeFilters]);

  // Group events by todo items if available
  const groupedEvents = useMemo(() => {
    if (todos.length === 0) {
      // No todos, just show all events ungrouped
      return [{ title: 'Thinking Process', events, isCompleted: false, todoId: undefined }];
    }

    // For now, create logical groups based on event timing and todo completion
    const groups: ThoughtGroupProps[] = [];

    // Find completed todos and create groups
    const completedTodos = todos.filter(t => t.status === 'completed');
    const inProgressTodo = todos.find(t => t.status === 'in_progress');

    // If we have events but no clear grouping, show them in a single group
    if (completedTodos.length === 0 && !inProgressTodo) {
      return [{ title: 'Initial Analysis', events, isCompleted: false, todoId: undefined }];
    }

    // Simple strategy: split events roughly equally among completed todos + current
    const totalGroups = completedTodos.length + (inProgressTodo ? 1 : 0);

    if (totalGroups === 0 || events.length === 0) {
      return [{ title: 'Thinking Process', events, isCompleted: false, todoId: undefined }];
    }

    const eventsPerGroup = Math.ceil(events.length / totalGroups);

    completedTodos.forEach((todo, idx) => {
      const start = idx * eventsPerGroup;
      const end = Math.min(start + eventsPerGroup, events.length);
      const groupEvents = events.slice(start, end);

      if (groupEvents.length > 0) {
        groups.push({
          title: todo.content,
          events: groupEvents,
          isCompleted: true,
          todoId: todo.id
        });
      }
    });

    if (inProgressTodo) {
      const start = completedTodos.length * eventsPerGroup;
      const groupEvents = events.slice(start);

      if (groupEvents.length > 0) {
        groups.push({
          title: inProgressTodo.content,
          events: groupEvents,
          isCompleted: false,
          todoId: inProgressTodo.id
        });
      }
    }

    // If no groups were created, show all events
    if (groups.length === 0) {
      return [{ title: 'Thinking Process', events, isCompleted: false, todoId: undefined }];
    }

    return groups;
  }, [events, todos]);

  if (events.length === 0) {
    return null;
  }

  return (
    <div id="thinking-log-section" className="min-w-0 overflow-hidden">
      {/* Grouped Events - terminal style log feed */}
      <div className="space-y-3 min-w-0">
        {groupedEvents.map((group, index) => (
          <ThoughtGroup
            key={group.todoId || index}
            title={group.title}
            events={group.events}
            isCompleted={group.isCompleted}
            todoId={group.todoId}
            isHighlighted={highlightedTodoId === group.todoId}
            activeFilters={activeFilters}
          />
        ))}
      </div>

      {/* Show filtered count if filtering is active */}
      {activeFilters && activeFilters.size > 0 && filteredEventCount !== events.length && (
        <div className="text-[10px] text-gray-400 mt-2 text-center">
          Showing {filteredEventCount} of {events.length} thoughts
        </div>
      )}
    </div>
  );
};

export default ThinkingLog;
