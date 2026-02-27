import React, { useCallback } from 'react';
import { LiveDetails, HistoryItem } from './types';

interface TodoListProps {
  liveDetails: LiveDetails;
  history: HistoryItem[];
  onTodoHover?: (todoId: string | null) => void;
}

const TodoList: React.FC<TodoListProps> = ({ liveDetails, history, onTodoHover }) => {
  const scrollToThinkingLog = useCallback((todoId: string, todoContent: string) => {
    // First try to find the specific thinking log group for this todo by ID
    let element = document.getElementById(`thinking-log-${todoId}`);

    // If not found, try to find by data-todo-id attribute
    if (!element) {
      element = document.querySelector(`[data-todo-id="${todoId}"]`) as HTMLElement;
    }

    // If still not found, try to find by matching content (the todo text)
    // This handles cases where IDs don't match but the content is the same
    if (!element) {
      element = document.querySelector(`[data-todo-content="${CSS.escape(todoContent)}"]`) as HTMLElement;
    }

    // If still not found, scroll to the thinking log section header
    if (!element) {
      element = document.getElementById('thinking-log-section');
    }

    // If still not found, scroll to the execution event log
    if (!element) {
      element = document.getElementById('execution-event-log-section');
    }

    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Add a brief highlight effect
      element.classList.add('ring-2', 'ring-blue-400', 'ring-offset-2');
      setTimeout(() => {
        element.classList.remove('ring-2', 'ring-blue-400', 'ring-offset-2');
      }, 2000);
    }
  }, []);

  if (liveDetails.todos.length === 0 || history.length === 0) {
    return null;
  }

  const isTaskActive = !['COMPLETED', 'FAILED'].includes(history[history.length - 1]?.state?.toUpperCase() || '');

  return (
    <div className="border-t border-gray-100 pt-4">
      {isTaskActive && (
        <>
          <h4 className="mt-0 mb-3 text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span className="text-base">⚡</span>
            <span className="flex items-center gap-2">
              Live Progress
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
            </span>
          </h4>
          {liveDetails.currentTask && (
            <p className="mb-3 p-2 bg-blue-50 rounded text-sm border-l-2 border-blue-500">
              <strong className="text-blue-800">Current:</strong>{' '}
              <span className="text-blue-700">{liveDetails.currentTask}</span>
            </p>
          )}
        </>
      )}
      {!isTaskActive && (
        <h4 className="mt-0 mb-3 text-sm font-semibold text-gray-900">
          To-do List
        </h4>
      )}
      <ul className="list-none pl-0 m-0 space-y-1">
        {liveDetails.todos.map(todo => (
          <li
            key={todo.id}
            className={`flex items-start gap-2 py-1.5 px-2 rounded text-sm transition-colors cursor-pointer hover:bg-gray-50 ${
              todo.status === 'in_progress' ? 'bg-blue-50' : ''
            }`}
            onClick={() => scrollToThinkingLog(todo.id, todo.content)}
            onMouseEnter={() => onTodoHover?.(todo.id)}
            onMouseLeave={() => onTodoHover?.(null)}
            title="Click to scroll to related thinking log"
          >
            <span className="flex-shrink-0 text-sm leading-5">
              {todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '⏳' : '📋'}
            </span>
            <span className={`leading-5 ${
              todo.status === 'completed' ? 'text-gray-400 line-through' : 'text-gray-700'
            } ${
              todo.status === 'in_progress' ? 'font-medium text-blue-800' : 'font-normal'
            }`}>
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default TodoList;
