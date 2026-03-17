import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Check, Trash2, Edit3, Sparkles } from 'lucide-react';
import { RepoTodo } from '../../../api/repoTodosApi';

export interface SortableTodoItemProps {
  todo: RepoTodo;
  isSelected: boolean;
  onToggleSelect: (todoId: string) => void;
  onToggleComplete: (todoId: string, isCompleted: boolean) => void;
  onDelete: (todoId: string) => void;
  onEdit: (todoId: string, content: string) => void;
  disabled?: boolean;
}

const SortableTodoItem: React.FC<SortableTodoItemProps> = ({
  todo,
  isSelected,
  onToggleSelect,
  onToggleComplete,
  onDelete,
  onEdit,
  disabled,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(todo.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.todoId, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    if (isEditing) {
      adjustTextareaHeight();
    }
  }, [isEditing, editContent, adjustTextareaHeight]);

  const handleSaveEdit = () => {
    if (editContent.trim() && editContent !== todo.content) {
      onEdit(todo.todoId, editContent.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      setEditContent(todo.content);
      setIsEditing(false);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditContent(e.target.value);
    adjustTextareaHeight();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-start gap-2 p-2.5 rounded-lg border transition-all
        ${isDragging ? 'opacity-50 bg-slate-100 shadow-lg z-50' : 'bg-white border-slate-200'}
        ${isSelected && !todo.isCompleted ? 'ring-2 ring-teal-500 border-teal-300' : ''}
        ${todo.isCompleted ? 'opacity-60' : ''}
        ${disabled ? 'cursor-not-allowed' : ''}
      `}
    >
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className={`flex-shrink-0 mt-0.5 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 transition-colors
          ${disabled ? 'pointer-events-none' : ''}
        `}
      >
        <GripVertical size={14} />
      </div>

      {/* Selection checkbox (only for non-completed items) */}
      {!todo.isCompleted && (
        <button
          onClick={() => onToggleSelect(todo.todoId)}
          disabled={disabled}
          className={`flex-shrink-0 w-4 h-4 mt-0.5 rounded border transition-all
            ${isSelected
              ? 'bg-teal-500 border-teal-500 text-white'
              : 'border-slate-300 hover:border-teal-400'
            }
            ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
          `}
        >
          {isSelected && <Check size={12} className="m-auto" />}
        </button>
      )}

      {/* Completion checkbox */}
      <button
        onClick={() => onToggleComplete(todo.todoId, !todo.isCompleted)}
        disabled={disabled}
        className={`flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-2 transition-all
          ${todo.isCompleted
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-slate-300 hover:border-green-400'
          }
          ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        {todo.isCompleted && <Check size={10} className="m-auto" />}
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={handleTextareaChange}
            onBlur={handleSaveEdit}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-full px-2 py-1 text-sm border border-teal-300 rounded focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none overflow-hidden"
            style={{ minHeight: '2rem' }}
          />
        ) : (
          <p
            className={`text-sm leading-relaxed break-words whitespace-pre-wrap
              ${todo.isCompleted ? 'line-through text-slate-400' : 'text-slate-700'}
            `}
          >
            {todo.content}
          </p>
        )}
        {todo.linkedDraftId && (
          <span className="inline-flex items-center gap-1 mt-1 text-[10px] text-teal-600 bg-teal-50 px-1.5 py-0.5 rounded">
            <Sparkles size={10} />
            Linked to plan
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isEditing && !todo.isCompleted && (
          <button
            onClick={() => setIsEditing(true)}
            disabled={disabled}
            className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
            title="Edit"
          >
            <Edit3 size={12} />
          </button>
        )}
        <button
          onClick={() => onDelete(todo.todoId)}
          disabled={disabled}
          className="p-1 text-slate-400 hover:text-red-500 transition-colors"
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
};

export default SortableTodoItem;
