import React, { useState, useEffect } from 'react';
import { Check, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { RepoTodo } from '../../../api/repoTodosApi';
import TodoIssueLink from './TodoIssueLink';
import { focusRing, revealOnHover, rowControl, rowIcon, rowIconButton } from './rowStyles';

export interface CompletedItemsAccordionProps {
  todos: RepoTodo[];
  onToggleComplete: (todoId: string, isCompleted: boolean) => void;
  onDeleteTodo: (todoId: string) => void;
  disabled?: boolean;
  forceExpand?: boolean;
}

const CompletedItemsAccordion: React.FC<CompletedItemsAccordionProps> = ({
  todos,
  onToggleComplete,
  onDeleteTodo,
  disabled,
  forceExpand,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (forceExpand) {
      setIsExpanded(true);
    }
  }, [forceExpand]);

  if (todos.length === 0) return null;

  return (
    <div className="mt-6 pt-4 border-t border-slate-200">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className={`flex items-center gap-2 w-full text-left py-1.5 px-2 touch:min-h-11 rounded-md hover:bg-slate-100 transition-colors ${focusRing}`}
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Check size={14} className="text-green-500" />
        <span className="flex-1 text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Completed Items
        </span>
        <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
          {todos.length}
        </span>
      </button>

      {isExpanded && (
        <div className="mt-2 space-y-1.5 ml-4">
          {/* Completed rows are still readable content with live controls, so they are
              never faded: the strikethrough and slate-50 fill mark them as done. */}
          {todos.map((todo) => (
            <div
              key={todo.todoId}
              data-testid="repo-todo-row"
              className="group flex items-start gap-2 p-2.5 rounded-lg border bg-slate-50 border-slate-200
                touch:grid touch:grid-cols-[auto_minmax(0,1fr)_auto] touch:gap-x-1 touch:gap-y-1 touch:p-2 touch:pb-1
                touch:[grid-template-areas:'content_content_content'_'restore_._delete']"
            >
              <button
                onClick={() => onToggleComplete(todo.todoId, false)}
                disabled={disabled}
                aria-label={`Restore todo: ${todo.content}`}
                className={`${rowControl} mt-0.5 touch:[grid-area:restore] cursor-pointer disabled:cursor-not-allowed`}
                title="Mark as incomplete"
              >
                <span
                  aria-hidden="true"
                  className="flex items-center justify-center w-4 h-4 touch:w-6 touch:h-6 rounded-full border-2 bg-green-500 border-green-500 text-white"
                >
                  <Check size={10} className={rowIcon} />
                </span>
              </button>
              <div className="flex-1 min-w-0 touch:[grid-area:content] touch:px-1 touch:pt-0.5">
                <p className="text-sm text-slate-600 line-through break-words whitespace-pre-wrap">
                  {todo.content}
                </p>
                <TodoIssueLink todo={todo} className="mt-1" />
              </div>
              <button
                onClick={() => onDeleteTodo(todo.todoId)}
                disabled={disabled}
                aria-label={`Delete todo: ${todo.content}`}
                className={`${rowIconButton} touch:[grid-area:delete] text-slate-500 hover:text-red-500 ${revealOnHover}`}
                title="Delete"
              >
                <Trash2 size={12} className={rowIcon} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CompletedItemsAccordion;
