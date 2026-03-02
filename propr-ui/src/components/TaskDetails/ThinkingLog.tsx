import React, { useMemo } from 'react';
import { LiveEvent, TodoItem } from './types';
import { renderMarkdown } from './renderMarkdown';
import { Lightbulb, Wrench, Search, CheckCircle2 } from 'lucide-react';

// Simple thought type detection based on content
const detectThoughtType = (content: string): 'analysis' | 'action' | 'summary' | 'search' => {
  const lower = content.toLowerCase();
  if (lower.includes('search') || lower.includes('find') || lower.includes('look for')) return 'search';
  if (lower.includes('create') || lower.includes('update') || lower.includes('modify') || lower.includes('implement')) return 'action';
  if (lower.includes('summary') || lower.includes('complete') || lower.includes('done') || lower.includes('finished')) return 'summary';
  return 'analysis';
};

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

interface ThinkingLogProps {
  events: ThinkingLogEvent[];
  todos?: TodoItem[];
  highlightedTodoId?: string | null;
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
            <span className={`text-[11px] font-bold uppercase tracking-widest ${categoryInfo.textColor}`}>
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
            <div className="text-[13px] text-gray-700 mt-0.5 leading-relaxed break-words overflow-hidden">
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
}

const ThoughtGroup: React.FC<ThoughtGroupProps> = ({ title, events, isCompleted, todoId, isHighlighted }) => {
  if (events.length === 0) return null;

  return (
    <div
      className={`transition-all duration-300 ${
        isHighlighted ? 'ring-1 ring-blue-300 ring-offset-1 rounded' : ''
      }`}
      id={todoId ? `thinking-log-${todoId}` : undefined}
      data-todo-id={todoId}
      data-todo-content={title}
    >
      {/* Group Header - todo subheader style */}
      <div className="flex items-center gap-2 py-2 px-2 bg-slate-50 border-l-2 border-slate-300 mb-2 mt-3 first:mt-0">
        {isCompleted ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" />
        ) : (
          <div className="h-3.5 w-3.5 rounded-full border-2 border-blue-400 bg-blue-50 flex-shrink-0" />
        )}
        <span className={`text-[13px] font-semibold ${isCompleted ? 'text-slate-700' : 'text-slate-800'}`}>
          {title}
        </span>
        <span className="text-[10px] text-slate-400 font-medium ml-auto flex-shrink-0">
          {events.length} {events.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {/* Log entries */}
      <div className="space-y-0 divide-y divide-gray-50">
        {events.map((event, index) => (
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

const ThinkingLog: React.FC<ThinkingLogProps> = ({ events, todos = [], highlightedTodoId }) => {
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
      {/* Section Header */}
      <div className="mb-4 flex items-center gap-2">
        <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 m-0">
          IMPLEMENTATION LOG
        </h4>
        <div className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-500 font-mono text-[10px] font-bold">
          {events.length}
        </div>
      </div>

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
          />
        ))}
      </div>

    </div>
  );
};

export default ThinkingLog;
