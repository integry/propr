import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Check, Trash2, Edit3, Sparkles } from 'lucide-react';
import { RepoTodo } from '../../../api/repoTodosApi';
import { CreatorMarker } from '../../CreatorMarker';
import TodoIssueLink from './TodoIssueLink';
import { revealOnHover, rowControl, rowIcon, rowIconButton } from './rowStyles';

export interface SortableTodoItemProps {
  todo: RepoTodo;
  isSelected: boolean;
  onToggleSelect: (todoId: string) => void;
  onToggleComplete: (todoId: string, isCompleted: boolean) => void;
  onDelete: (todoId: string) => void;
  onEdit: (todoId: string, content: string) => void;
  disabled?: boolean;
}

/** Avatar only, in the row's own line box, so the item stays one dense row; nothing at all when the creator is unknown. */
const TodoCreator: React.FC<{ todo: RepoTodo }> = ({ todo }) => (todo.createdBy ? (
  <span className="flex-shrink-0 flex mt-[3px] touch:[grid-area:creator]">
    <CreatorMarker creator={todo.createdBy} avatarOnly />
  </span>
) : null);

/** Links from a to-do to the plan or issue it was turned into. */
const TodoLinkChips: React.FC<{ todo: RepoTodo }> = ({ todo }) => {
  if (!todo.linkedDraftId && !todo.linkedIssueNumber) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {todo.linkedDraftId && (
        <span className="inline-flex items-center gap-1 text-[10px] text-teal-600 bg-teal-50 px-1.5 py-0.5 rounded">
          <Sparkles size={10} />
          Linked to plan
        </span>
      )}
      <TodoIssueLink todo={todo} />
    </div>
  );
};

type ToggleProps = Pick<SortableTodoItemProps, 'todo' | 'disabled'>;

/** Square checkbox that adds the to-do to the plan/task selection. */
const SelectToggle: React.FC<ToggleProps & Pick<SortableTodoItemProps, 'isSelected' | 'onToggleSelect'>> = ({
  todo, isSelected, onToggleSelect, disabled,
}) => (
  <button
    aria-label={`Select todo: ${todo.content}`}
    aria-pressed={isSelected}
    title={isSelected ? 'Deselect' : 'Select'}
    onClick={() => onToggleSelect(todo.todoId)}
    disabled={disabled}
    className={`group/select ${rowControl} mt-0.5 touch:[grid-area:select] ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
  >
    <span
      aria-hidden="true"
      className={`flex items-center justify-center w-4 h-4 touch:w-6 touch:h-6 rounded border transition-all
        ${isSelected
          ? 'bg-teal-500 border-teal-500 text-white'
          : 'border-slate-300 touch:border-slate-400 group-hover/select:border-teal-400'
        }
      `}
    >
      {isSelected && <Check size={12} className={rowIcon} />}
    </span>
  </button>
);

/** Round check that completes the to-do, or restores it once completed. */
const CompleteToggle: React.FC<ToggleProps & Pick<SortableTodoItemProps, 'onToggleComplete'>> = ({
  todo, onToggleComplete, disabled,
}) => (
  <button
    onClick={() => onToggleComplete(todo.todoId, !todo.isCompleted)}
    disabled={disabled}
    aria-label={`${todo.isCompleted ? 'Restore' : 'Complete'} todo: ${todo.content}`}
    className={`group/complete ${rowControl} mt-0.5 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
    title={todo.isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
  >
    <span
      aria-hidden="true"
      className={`w-5 h-5 touch:w-6 touch:h-6 rounded-full border-2 transition-all flex items-center justify-center
        ${todo.isCompleted
          ? 'bg-green-500 border-green-500 text-white'
          : 'border-slate-300 touch:border-slate-400 group-hover/complete:border-green-500 group-hover/complete:bg-green-50'
        }
      `}
    >
      <Check
        size={12}
        className={todo.isCompleted
          ? rowIcon
          : `${rowIcon} opacity-0 touch:opacity-40 group-hover/complete:opacity-50 text-green-500 transition-opacity`}
      />
    </span>
  </button>
);

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
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // Enter/Escape leave the editor from the keyboard: hand focus back to Edit.
  const refocusEditRef = useRef(false);

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

  useEffect(() => {
    if (!isEditing && refocusEditRef.current) {
      refocusEditRef.current = false;
      editButtonRef.current?.focus();
    }
  }, [isEditing]);

  const handleSaveEdit = () => {
    if (editContent.trim() && editContent !== todo.content) {
      onEdit(todo.todoId, editContent.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      refocusEditRef.current = true;
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      refocusEditRef.current = true;
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
      data-testid="repo-todo-row"
      className={`group flex items-start gap-2 p-2.5 rounded-lg border transition-all
        touch:grid touch:grid-cols-[auto_auto_minmax(0,1fr)_auto] touch:gap-x-1 touch:gap-y-1 touch:p-2 touch:pb-1
        touch:[grid-template-areas:'content_content_content_creator'_'grip_select_trail_trail']
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
        aria-label={`Reorder todo: ${todo.content}`}
        title="Drag to reorder"
        className={`${rowControl} mt-0.5 touch:[grid-area:grip] touch:touch-none cursor-grab active:cursor-grabbing text-slate-300 touch:text-slate-400 hover:text-slate-500 transition-colors
          ${disabled ? 'pointer-events-none' : ''}
        `}
      >
        <GripVertical size={14} className={rowIcon} />
      </div>

      {/* Selection checkbox (only for non-completed items) */}
      {!todo.isCompleted && (
        <SelectToggle todo={todo} isSelected={isSelected} onToggleSelect={onToggleSelect} disabled={disabled} />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0 touch:[grid-area:content] touch:px-1 touch:pt-0.5">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            aria-label="Edit todo"
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
        <TodoLinkChips todo={todo} />
      </div>

      <TodoCreator todo={todo} />

      <div className="flex-shrink-0 flex items-start gap-2 touch:[grid-area:trail] touch:items-center touch:justify-end touch:gap-1">
        <CompleteToggle todo={todo} onToggleComplete={onToggleComplete} disabled={disabled} />

        {/* Actions */}
        <div className={`flex items-center gap-1 ${revealOnHover}`}>
          {!isEditing && !todo.isCompleted && (
            <button
              ref={editButtonRef}
              onClick={() => setIsEditing(true)}
              disabled={disabled}
              aria-label={`Edit todo: ${todo.content}`}
              className={`${rowIconButton} text-slate-400 hover:text-slate-600`}
              title="Edit"
            >
              <Edit3 size={12} className={rowIcon} />
            </button>
          )}
          <button
            onClick={() => onDelete(todo.todoId)}
            disabled={disabled}
            aria-label={`Delete todo: ${todo.content}`}
            className={`${rowIconButton} text-slate-400 hover:text-red-500`}
            title="Delete"
          >
            <Trash2 size={12} className={rowIcon} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default SortableTodoItem;
