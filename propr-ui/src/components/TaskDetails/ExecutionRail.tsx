import React, { useCallback } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';
import { LiveDetails, HistoryItem } from './types';

interface ExecutionRailProps {
  liveDetails: LiveDetails;
  history: HistoryItem[];
  onTodoHover?: (todoId: string | null) => void;
}

const ExecutionRail: React.FC<ExecutionRailProps> = ({ liveDetails, history, onTodoHover }) => {
  const scrollToThinkingLog = useCallback((todoId: string, todoContent: string) => {
    // First try to find the specific thinking log group for this todo by ID
    let element = document.getElementById(`thinking-log-${todoId}`);

    // If not found, try to find by data-todo-id attribute
    if (!element) {
      element = document.querySelector(`[data-todo-id="${todoId}"]`) as HTMLElement;
    }

    // If still not found, try to find by matching content (the todo text)
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
      element.classList.add('ring-2', 'ring-primary-500', 'ring-offset-2');
      setTimeout(() => {
        element.classList.remove('ring-2', 'ring-primary-500', 'ring-offset-2');
      }, 2000);
    }
  }, []);

  if (liveDetails.todos.length === 0 || history.length === 0) {
    return null;
  }

  const isTaskActive = !['COMPLETED', 'FAILED'].includes(history[history.length - 1]?.state?.toUpperCase() || '');

  return (
    <div className="pt-4">
      {/* Header */}
      <h4 className="mt-0 mb-4 text-sm font-semibold text-gray-900 flex items-center gap-2">
        {isTaskActive ? (
          <>
            <span className="text-base">⚡</span>
            <span className="flex items-center gap-2">
              Execution Rail
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-500 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-500"></span>
              </span>
            </span>
          </>
        ) : (
          <span>Execution Rail</span>
        )}
      </h4>

      {/* Execution Rail with Vertical Line */}
      <div className="relative">
        {/* Vertical Threading Rail - continuous line in left gutter */}
        <div className="absolute left-[11px] top-0 bottom-0 w-0.5 border-l-2 border-gray-200" />

        {/* Todo Items */}
        <ul className="list-none pl-0 m-0 space-y-0 relative">
          {liveDetails.todos.map((todo) => {
            const isCompleted = todo.status === 'completed';
            const isInProgress = todo.status === 'in_progress';

            return (
              <li
                key={todo.id}
                className={`flex items-start gap-3 py-2 pl-0 pr-2 text-sm transition-colors cursor-pointer hover:bg-gray-50 rounded-r ${
                  isInProgress ? 'bg-primary-500/5' : ''
                }`}
                onClick={() => scrollToThinkingLog(todo.id, todo.content)}
                onMouseEnter={() => onTodoHover?.(todo.id)}
                onMouseLeave={() => onTodoHover?.(null)}
                title="Click to scroll to related thinking log"
              >
                {/* Icon intersecting the rail */}
                <div className="relative flex-shrink-0 z-10">
                  {isCompleted ? (
                    // Completed: Gray checkmarks - "Success is Quiet" principle
                    <div className="w-6 h-6 rounded-full flex items-center justify-center bg-white border-2 border-slate-300">
                      <Check className="w-3.5 h-3.5 text-slate-400" />
                    </div>
                  ) : isInProgress ? (
                    // Current/In Progress: Teal animated pulse icon
                    <div className="relative">
                      <div className="absolute inset-0 w-6 h-6 rounded-full bg-primary-500 animate-ping opacity-30" />
                      <div className="relative w-6 h-6 rounded-full bg-primary-500 flex items-center justify-center">
                        <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
                      </div>
                    </div>
                  ) : (
                    // Pending: hollow circle
                    <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center border-2 border-gray-200">
                      <Circle className="w-2 h-2 text-gray-300 fill-gray-300" />
                    </div>
                  )}
                </div>

                {/* Todo content */}
                <span
                  className={`leading-6 ${
                    isCompleted
                      ? isTaskActive
                        ? 'text-gray-400 line-through' // Live task: gray + strikethrough for completed items
                        : 'text-gray-700' // Finished task: normal readable text for completed items
                      : isInProgress
                      ? 'font-medium text-primary-600'
                      : 'text-gray-600'
                  }`}
                >
                  {todo.content}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

export default ExecutionRail;
