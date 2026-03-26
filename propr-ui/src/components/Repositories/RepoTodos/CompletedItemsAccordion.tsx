import React, { useState, useEffect } from 'react';
import { Check, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { RepoTodo } from '../../../api/repoTodosApi';

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
        className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded-md hover:bg-slate-100 transition-colors"
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
          {todos.map((todo) => (
            <div
              key={todo.todoId}
              className="group flex items-start gap-2 p-2.5 rounded-lg border bg-slate-50 border-slate-200 opacity-60"
            >
              <button
                onClick={() => onToggleComplete(todo.todoId, false)}
                disabled={disabled}
                className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-2 bg-green-500 border-green-500 text-white cursor-pointer"
                title="Mark as incomplete"
              >
                <Check size={10} className="m-auto" />
              </button>
              <p className="flex-1 text-sm text-slate-400 line-through break-words">
                {todo.content}
              </p>
              <button
                onClick={() => onDeleteTodo(todo.todoId)}
                disabled={disabled}
                className="flex-shrink-0 p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CompletedItemsAccordion;
