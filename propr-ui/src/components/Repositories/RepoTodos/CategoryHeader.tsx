import React, { useState } from 'react';
import { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Trash2,
  Edit3,
  GripVertical,
} from 'lucide-react';
import { RepoTodoCategory } from '../../../api/repoTodosApi';

export interface CategoryHeaderProps {
  category: RepoTodoCategory | null;
  todoCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onAddTodo: (categoryId: string | null) => void;
  onEditCategory?: (categoryId: string, name: string) => void;
  onDeleteCategory?: (categoryId: string) => void;
  disabled?: boolean;
  isSortable?: boolean;
  sortableAttributes?: Record<string, unknown>;
  sortableListeners?: SyntheticListenerMap;
}

const CategoryHeader: React.FC<CategoryHeaderProps> = ({
  category,
  todoCount,
  isExpanded,
  onToggleExpand,
  onAddTodo,
  onEditCategory,
  onDeleteCategory,
  disabled,
  isSortable = false,
  sortableAttributes,
  sortableListeners,
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(category?.name || '');
  const categoryId = category?.categoryId || null;
  const categoryName = category?.name || 'Uncategorized';

  const handleSaveName = () => {
    if (category && editName.trim() && editName !== category.name && onEditCategory) {
      onEditCategory(category.categoryId, editName.trim());
    }
    setIsEditingName(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveName();
    } else if (e.key === 'Escape' && category) {
      setEditName(category.name);
      setIsEditingName(false);
    }
  };

  const handleStartEdit = () => {
    if (category) {
      setIsEditingName(true);
    }
  };

  return (
    <div className="group flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-slate-100 transition-colors">
      {/* Drag handle for category reordering */}
      {isSortable && category && (
        <div
          {...sortableAttributes}
          {...sortableListeners}
          className={`flex-shrink-0 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 transition-colors
            ${disabled ? 'pointer-events-none' : ''}
          `}
        >
          <GripVertical size={14} />
        </div>
      )}
      <button
        onClick={onToggleExpand}
        className="flex-shrink-0 text-slate-400 hover:text-slate-600"
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <div className="flex-shrink-0 text-slate-400">
        {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
      </div>
      {isEditingName && category ? (
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSaveName}
          onKeyDown={handleKeyDown}
          autoFocus
          className="flex-1 px-1 text-xs font-semibold text-slate-700 border border-teal-300 rounded focus:outline-none focus:ring-1 focus:ring-teal-500"
        />
      ) : (
        <span
          className="flex-1 text-xs font-semibold text-slate-600 uppercase tracking-wider cursor-pointer"
          onClick={handleStartEdit}
        >
          {categoryName}
        </span>
      )}
      <span className="text-[10px] text-slate-400">{todoCount}</span>
      {category && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleStartEdit}
            className="p-0.5 text-slate-400 hover:text-slate-600"
            title="Edit category name"
          >
            <Edit3 size={10} />
          </button>
          <button
            onClick={() => onDeleteCategory?.(category.categoryId)}
            className="p-0.5 text-slate-400 hover:text-red-500"
            title="Delete category"
          >
            <Trash2 size={10} />
          </button>
        </div>
      )}
      <button
        onClick={() => onAddTodo(categoryId)}
        disabled={disabled}
        className="p-0.5 text-slate-400 hover:text-teal-600"
        title="Add to-do"
      >
        <Plus size={12} />
      </button>
    </div>
  );
};

export default CategoryHeader;
