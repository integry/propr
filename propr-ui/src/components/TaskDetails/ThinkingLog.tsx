import React, { useMemo } from 'react';
import { LiveEvent, TodoItem } from './types';
import { renderMarkdown } from './renderMarkdown';
import { MessageSquareText, Lightbulb, Wrench, Search, CheckCircle2, ListChecks } from 'lucide-react';

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

interface ThinkingLogProps {
  events: ThinkingLogEvent[];
  todos?: TodoItem[];
  highlightedTodoId?: string | null;
}

// Pattern lists for thought type detection
const SUMMARY_PATTERNS = ['implementation summary', 'summary:', 'completed:', 'successfully'];
const ANALYSIS_PATTERNS = ['i will analyze', 'let me analyze', 'looking at', 'examining', 'reviewing', 'understanding', 'i need to understand', 'let me understand'];
const SEARCH_PATTERNS = ['searching', 'let me search', 'looking for', 'finding'];
const ACTION_PATTERNS = ['now let me', 'i will create', 'i will update', 'i will modify', 'i will add', 'i will implement', 'let me create', 'let me update', 'let me modify', 'let me add', 'creating', 'updating', 'modifying'];

const matchesAnyPattern = (content: string, patterns: string[]): boolean =>
  patterns.some(pattern => content.includes(pattern));

// Detect the type of thought based on content
const detectThoughtType = (content: string): 'analysis' | 'action' | 'summary' | 'search' => {
  const lowerContent = content.toLowerCase();

  if (matchesAnyPattern(lowerContent, SUMMARY_PATTERNS)) return 'summary';
  if (matchesAnyPattern(lowerContent, ANALYSIS_PATTERNS)) return 'analysis';
  if (matchesAnyPattern(lowerContent, SEARCH_PATTERNS)) return 'search';
  if (matchesAnyPattern(lowerContent, ACTION_PATTERNS)) return 'action';

  return 'analysis';
};

const getThoughtStyles = (type: 'analysis' | 'action' | 'summary' | 'search') => {
  switch (type) {
    case 'summary':
      return {
        bgColor: 'bg-amber-50',
        borderColor: 'border-amber-200',
        iconBg: 'bg-amber-100',
        iconColor: 'text-amber-600',
        Icon: CheckCircle2
      };
    case 'action':
      return {
        bgColor: 'bg-green-50',
        borderColor: 'border-green-200',
        iconBg: 'bg-green-100',
        iconColor: 'text-green-600',
        Icon: Wrench
      };
    case 'search':
      return {
        bgColor: 'bg-purple-50',
        borderColor: 'border-purple-200',
        iconBg: 'bg-purple-100',
        iconColor: 'text-purple-600',
        Icon: Search
      };
    case 'analysis':
    default:
      return {
        bgColor: 'bg-blue-50',
        borderColor: 'border-blue-200',
        iconBg: 'bg-blue-100',
        iconColor: 'text-blue-600',
        Icon: Lightbulb
      };
  }
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
      className={`mb-4 transition-all duration-300 ${
        isHighlighted ? 'ring-2 ring-blue-400 ring-offset-2 rounded-lg' : ''
      }`}
      id={todoId ? `thinking-log-${todoId}` : undefined}
      data-todo-id={todoId}
      data-todo-content={title}
    >
      {/* Group Header */}
      <div className={`flex items-center gap-2 mb-2 px-3 py-1.5 rounded-t-lg ${isCompleted ? 'bg-green-100' : 'bg-gray-100'}`}>
        {isCompleted ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        ) : (
          <ListChecks className="h-4 w-4 text-gray-600" />
        )}
        <span className={`text-sm font-medium ${isCompleted ? 'text-green-800' : 'text-gray-700'}`}>
          {title}
        </span>
      </div>

      {/* Grouped Thoughts */}
      <div className="space-y-2 pl-2 border-l-2 border-gray-200 ml-2">
        {events.map((event, index) => {
          const thoughtType = detectThoughtType(event.content || '');
          const styles = getThoughtStyles(thoughtType);
          const { Icon } = styles;

          return (
            <div
              key={index}
              className={`flex items-start gap-3 p-3 rounded-lg border ${styles.bgColor} ${styles.borderColor}`}
            >
              <div className={`flex-shrink-0 w-7 h-7 rounded-full ${styles.iconBg} flex items-center justify-center`}>
                <Icon className={`h-4 w-4 ${styles.iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                {/* Changed from whitespace-pre-wrap to allow ReactMarkdown to handle spacing */}
                <div className="text-gray-700 text-sm break-words">
                  {renderMarkdown(event.content)}
                </div>
                {event.relativeTime && (
                  <p className="text-xs text-gray-500 mt-1">{event.relativeTime}</p>
                )}
              </div>
            </div>
          );
        })}
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
    // This is a simplified grouping - in a real implementation, you might have
    // more sophisticated correlation between thoughts and todos
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
    <div className="mb-6" id="thinking-log-section">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquareText className="h-5 w-5 text-gray-700" />
        <h4 className="text-lg font-semibold text-gray-900">Thinking Log</h4>
        <span className="text-sm text-gray-500">({events.length} thoughts)</span>
      </div>

      <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
        {/* Legend */}
        <div className="flex flex-wrap gap-4 mb-4 pb-3 border-b border-gray-200 text-xs">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-blue-100 border border-blue-200"></div>
            <span className="text-gray-600">Analysis</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-green-100 border border-green-200"></div>
            <span className="text-gray-600">Action</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-purple-100 border border-purple-200"></div>
            <span className="text-gray-600">Search</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-amber-100 border border-amber-200"></div>
            <span className="text-gray-600">Summary</span>
          </div>
        </div>

        {/* Grouped Events */}
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
