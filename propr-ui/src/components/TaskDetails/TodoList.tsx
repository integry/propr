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
    <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
      {isTaskActive && (
        <>
          <h4 className="mt-0 text-blue-900 flex items-center gap-2">
            <span className="text-xl animate-pulse">⚡</span>
            <span className="flex items-center gap-2">
              Live Task Progress
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
            </span>
          </h4>
          {liveDetails.currentTask && (
            <p className="mb-4 p-3 bg-blue-100 rounded-md border-l-4 border-blue-500 animate-pulse">
              <strong className="text-blue-900">Current Task:</strong> {liveDetails.currentTask}
            </p>
          )}
        </>
      )}
      <h5 className="mt-4 mb-2 text-blue-900">To-do List:</h5>
      <ul className="list-none pl-0 m-0">
        {liveDetails.todos.map(todo => (
          <li
            key={todo.id}
            className={`flex items-center mb-2 p-2 rounded transition-colors cursor-pointer hover:bg-blue-100 ${
              todo.status === 'in_progress' ? 'bg-blue-100' : ''
            }`}
            onClick={() => scrollToThinkingLog(todo.id, todo.content)}
            onMouseEnter={() => onTodoHover?.(todo.id)}
            onMouseLeave={() => onTodoHover?.(null)}
            title="Click to scroll to related thinking log"
          >
            <span className="mr-2 text-lg">
              {todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '⏳' : '📋'}
            </span>
            <span className={`${
              todo.status === 'completed' ? 'text-gray-500' : 'text-gray-700'
            } ${
              todo.status === 'in_progress' ? 'font-bold text-blue-800' : 'font-normal'
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
